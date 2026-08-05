import { CfKnexError } from '../core/errors'
import type { DriverAdapter, RawResult } from '../core/types'
import type { FullResult } from '@tidbcloud/serverless'

/**
 * The one method this adapter calls on a `@tidbcloud/serverless` `Connection`
 * (node_modules/@tidbcloud/serverless/dist/index.d.ts). Declared locally as a
 * shim, the same way src/adapters/mysql2.ts declares `Mysql2ConnectionShim`,
 * rather than importing the real `Connection<T>` class type: `Connection`'s
 * own `execute` signature is a generic conditional type keyed off the exact
 * literal shape of its `options` argument, and this adapter only ever calls
 * it one way. Always passing `{ fullResult: true }` is what makes that
 * conditional resolve to `FullResult` rather than the bare `Row[]` shape used
 * in fire-and-forget mode — `FullResult` is the only shape that carries
 * `rowsAffected`/`lastInsertId`, and forgetting to request it is exactly the
 * write-metadata bug (Defect B) this adapter exists to avoid.
 */
type TidbConnection = {
  execute(query: string, args: unknown[], options: { fullResult: true }): Promise<FullResult>
}

export type TidbHttpAdapterOptions = { url: string }

/**
 * A `DriverAdapter` over `@tidbcloud/serverless` 0.3.0's HTTP driver for TiDB
 * Cloud Serverless.
 *
 * ## Streaming
 * `capabilities.streaming` is `false`: `Connection.execute()`
 * (dist/index.js's `postQuery`) always `await`s `response.json()` in full
 * before returning — the package exposes no cursor or chunked-read API for
 * `DriverAdapter.stream()` to wrap.
 *
 * ## Transactions
 * `capabilities.transactions` is `false` below, but *not* because the
 * package makes BEGIN/COMMIT/ROLLBACK unreachable through this adapter's
 * plain `execute(sql, bindings)` surface — it doesn't. Read directly from
 * `node_modules/@tidbcloud/serverless/dist/index.js` (0.3.0): every
 * `Connection.execute()` call reads a private `this.session` field, sends it
 * as the `TiDB-Session` HTTP header, and overwrites it from the response
 * afterward — on *any* `Connection` instance, not only ones reached through
 * `conn.begin()`. `begin()` itself does nothing beyond that: it constructs a
 * new `Connection` and calls `execute("BEGIN")` on it (lines 305-310), and
 * `Tx.commit()`/`Tx.rollback()` are just `execute("COMMIT")`/
 * `execute("ROLLBACK")` on that same instance (lines 271-276) — no special
 * request field marks them as transactional beyond the session header every
 * `execute()` call already carries. A probe against a stub HTTP transport
 * (logging every outgoing request) confirmed this directly: `conn.begin()`
 * -> `tx.execute()` -> `tx.commit()` and three plain
 * `conn.execute("BEGIN"/…/"COMMIT")` calls issued on ONE `Connection`
 * produce byte-identical requests, save for a random per-request trace id.
 * Since `acquire()` below now hands out a fresh `Connection` per call (never
 * shared — see its own comment) and a knex transaction holds whichever
 * handle it receives for its entire lifetime, routing knex's
 * BEGIN/COMMIT/ROLLBACK through this adapter's ordinary `execute()` calls on
 * that one handle is mechanically the same request sequence the package's
 * own `begin()`/`Tx` path produces.
 *
 * What that probe does not establish is whether TiDB Cloud Serverless's real
 * gateway honors that session-affinity header as a genuinely isolated
 * transaction end to end — it was checked against a stub transport, not a
 * live TiDB Cloud endpoint, and there is no TiDB Cloud account available to
 * verify it against from here. `capabilities.transactions` stays `false`
 * until that verification happens against a live gateway (this project's
 * conformance suite, run against a real connection, is exactly what that
 * verification would be). The cost of guessing wrong in the `true` direction
 * is the worst failure mode this package's contract has: a `db.transaction()`
 * that looks like it works and silently commits a rollback. A `false` here
 * instead produces a typed `CfKnexError`, and flipping this to `true` once
 * verified against a live gateway is a one-line change.
 */
export function createTidbHttpAdapter(opts: TidbHttpAdapterOptions): DriverAdapter {
  return {
    dialect: 'mysql',
    driver: 'tidb-http',
    capabilities: { streaming: false, transactions: false },

    async acquire(): Promise<TidbConnection> {
      let serverless: typeof import('@tidbcloud/serverless')
      try {
        serverless = await import('@tidbcloud/serverless')
      } catch {
        throw CfKnexError.missingDriver('@tidbcloud/serverless')
      }
      // A brand-new `Connection` on every call — never one cached and shared
      // (contrast an earlier draft of this adapter, which shared one
      // instance and used that sharing as its reason not to attempt
      // transactions; see this function's doc comment for why that reasoning
      // didn't hold up). `createKnexClient` wires this into knex's
      // `acquireRawConnection()`, which tarn calls only when it needs an
      // additional pooled resource, and `db.transaction()` holds whichever
      // handle it receives for its entire lifetime. Handing the same
      // `Connection` to two callers would let an unrelated query share
      // whatever session state that instance's `this.session` field
      // currently holds — including, if a transaction were ever routed
      // through it, landing mid-transaction. `connect()` is a pure
      // constructor with no I/O (`dist/index.js`: `function connect(config)
      // { return new Connection(config) }`), so creating a fresh one per
      // `acquire()` call, exactly like src/adapters/mysql2.ts does for its
      // TCP connections, costs nothing extra.
      return serverless.connect({ url: opts.url, fetch }) as unknown as TidbConnection
    },

    // No socket or file descriptor to close: each `execute()` call above is
    // a complete, independent HTTP request/response over `fetch`. For a
    // handle like this one, doing nothing here already is closing it.
    async release(): Promise<void> {},

    async execute(handle, sql, bindings): Promise<RawResult> {
      const result: unknown = await (handle as TidbConnection).execute(sql, bindings, { fullResult: true })
      return toRawResult(result)
    },

    // Nothing for this adapter to tear down beyond individual handles:
    // unlike src/adapters/mysql2.ts, there is no adapter-level cache or
    // bookkeeping here that outlives a single handle. Trivially idempotent,
    // since it does nothing either time it's called.
    async destroy(): Promise<void> {},

    // No `validate()` — omitted entirely, not just set to a function that
    // always returns `true`. An HTTP-backed handle like this one reopens no
    // socket and holds no server-side session between calls, so there is
    // nothing that can go stale while it sits idle in the pool between
    // queries; `createKnexClient` (../core/client.ts) already treats a
    // missing `validate` as "always valid", which is the correct default
    // here, not a stricter check this adapter would otherwise have to
    // reimplement to opt back out of.
  }
}

/**
 * `execute()` above always requests `{ fullResult: true }`, so a well-formed
 * response is exactly the package's own `FullResult` shape
 * (node_modules/@tidbcloud/serverless/dist/index.d.ts): an object with
 * `rows: Row[] | null`, plus nullable `rowsAffected`/`lastInsertId`. A JSON
 * envelope crossing an HTTP boundary is exactly where a malformed or
 * unexpected shape becomes genuinely reachable — a proxy or mock that forgot
 * to honor `fullResult: true`, a response body that got truncated or mangled
 * in transit — and returning `(result as any).rows ?? []` unconditionally
 * would silently turn any of those into a successful empty result set
 * instead of surfacing the failure. Guard it the same way
 * src/adapters/mysql2.ts's `toRawResult` does — and, unlike that file,
 * `lastInsertId` and `rowsAffected` need the same treatment here, not just
 * `rows`: mysql2's equivalent numeric-string id comes from mysql2's own
 * length-coded packet parser, a value this project doesn't control the shape
 * of but does trust; `lastInsertId`/`rowsAffected` here come straight off
 * untrusted JSON crossing an HTTP boundary, so `normalizeInsertId`/
 * `normalizeAffectedRows` below reject anything that isn't the shape
 * `FullResult` promises instead of coercing it and hoping.
 */
function toRawResult(result: unknown): RawResult {
  // Rejects `null`, non-objects, and arrays explicitly — a bare `Row[]` (the
  // shape the package returns when `fullResult` was *not* honored) is itself
  // an object as far as `typeof` is concerned, so it must be ruled out
  // separately rather than by `typeof result !== 'object'` alone. A
  // `FullResult` always carries a `rows` key (possibly `null`, never
  // omitted), so requiring the key to be present — not merely tolerating it
  // being `undefined` — catches an object that merely lacks the field too.
  if (result === null || typeof result !== 'object' || Array.isArray(result) || !('rows' in result)) {
    throw CfKnexError.malformedResult(
      `tidb-http query did not return a fullResult object with a 'rows' field (got ${Array.isArray(result) ? 'an array' : result === null ? 'null' : typeof result})`,
    )
  }
  const rows = (result as { rows: unknown }).rows
  if (!(Array.isArray(rows) || rows === null)) {
    throw CfKnexError.malformedResult(`tidb-http query's 'rows' was neither an array nor null (got ${typeof rows})`)
  }

  const full = result as Partial<FullResult>
  return {
    rows: full.rows ?? [],
    insertId: normalizeInsertId(full.lastInsertId),
    affectedRows: normalizeAffectedRows(full.rowsAffected),
  }
}

/**
 * The package's own `FullResult.lastInsertId` type is `string | null`
 * (dist/index.d.ts) — confirmed at the source too: dist/index.js's
 * `Connection.execute()` reads it straight off the raw HTTP JSON body as
 * `resp?.sLastInsertID`, never through any numeric parsing, presumably so
 * that TiDB's `AUTO_RANDOM` and 64-bit auto-increment ids — both of which
 * routinely exceed `Number.MAX_SAFE_INTEGER` — never round-trip through a
 * precision-lossy JSON/JS number first. Converting a well-formed digit
 * string straight to `bigint` (rather than `Number(id)`, which would
 * silently corrupt exactly the large ids this exists to protect) mirrors
 * src/adapters/mysql2.ts's own handling of mysql2's equivalent
 * numeric-string case. But unlike that string, this one arrives over
 * untrusted JSON, so it is validated first rather than handed straight to
 * `BigInt()`: an unparseable string (`BigInt('oops')`) would otherwise throw
 * an opaque, uncaught `SyntaxError` instead of a typed `CfKnexError`, and an
 * empty string (`BigInt('') === 0n`) would otherwise silently masquerade as
 * a real id of `0`. The `number` branch below is not reachable through the
 * real package (its type never offers a plain `number` here) — it exists
 * only so a hand-built `RawResult`-shaped mock in a test is passed through
 * unchanged rather than needlessly widened to `bigint`.
 */
function normalizeInsertId(id: string | number | null | undefined): bigint | number | undefined {
  if (id === null || id === undefined) return undefined
  if (typeof id === 'number') return id
  if (!/^\d+$/.test(id)) {
    throw CfKnexError.malformedResult(`tidb-http lastInsertId was not a numeric string (got ${JSON.stringify(id)})`)
  }
  return BigInt(id)
}

/**
 * `FullResult.rowsAffected` is typed `number | null` (dist/index.d.ts) and
 * read straight off the raw HTTP JSON body with no validation
 * (dist/index.js). `RawResult.affectedRows` (../core/types.ts) is typed
 * `number`, and src/core/response.ts hands it straight to knex's own
 * `.update()`/`.delete()` return-value handling — a string here (a
 * malformed or truncated response, or a proxy that re-serialized the field)
 * would pass silently through as a string where every caller expects a
 * number, exactly the kind of unexpected-shape failure this HTTP boundary
 * makes reachable.
 */
function normalizeAffectedRows(value: number | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'number') {
    throw CfKnexError.malformedResult(`tidb-http rowsAffected was not a number (got ${typeof value})`)
  }
  return value
}
