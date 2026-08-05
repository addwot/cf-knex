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

export function createTidbHttpAdapter(opts: TidbHttpAdapterOptions): DriverAdapter {
  // A single connection, created lazily on first `acquire()` and returned
  // for every subsequent call, rather than a fresh one per call (contrast
  // src/adapters/mysql2.ts, which opens a brand-new TCP connection on every
  // `acquire()`). That is safe here specifically because this adapter
  // declares `capabilities.transactions: false` below and never routes a
  // multi-statement session through `execute()` — every call this adapter
  // makes is a one-shot, independently auto-committing HTTP request, so
  // there is no in-flight multi-step operation two concurrent callers could
  // corrupt by sharing this object. (The package's `Connection` class does
  // thread an HTTP session-affinity header, `this.session`, across calls
  // made on the *same* instance — see the `capabilities` comment below for
  // why that is exactly what makes ad-hoc BEGIN/COMMIT/ROLLBACK unsafe to
  // rely on, and exactly why this adapter never attempts it.) There is also
  // no socket or file descriptor to exhaust by keeping this around: an HTTP
  // client object like this one costs nothing to hold, unlike a pooled TCP
  // connection.
  let conn: TidbConnection | null = null

  return {
    dialect: 'mysql',
    driver: 'tidb-http',
    capabilities: {
      streaming: false,
      // Verified against node_modules/@tidbcloud/serverless/dist/index.d.ts
      // and dist/index.js (package version 0.3.0), not copied from a plan.
      // The package documents three usage modes (README.md): a "stateless"
      // default where `Connection.execute()` auto-commits every statement
      // independently, and two opt-in modes reached only through their own
      // dedicated APIs — `conn.persist()` -> `StatefulConnection`, and
      // `conn.begin()` -> `Tx` with named `commit()`/`rollback()` methods
      // (index.d.ts lines 100-118). `Tx.commit`/`Tx.rollback` are themselves
      // just `this.conn.execute("COMMIT"|"ROLLBACK")` (index.js lines
      // 271-276) on a *second*, separate `Connection` instance that
      // `begin()` constructs specifically for the transaction (index.js
      // lines 305-310) — never on the connection object a caller already
      // holds. `DriverAdapter.execute(handle, sql, bindings)` (../core/
      // types.ts) can only reach `handle.execute(sql, bindings, opts)`; it
      // has no way to call `handle.begin()` or hand knex a `Tx` object mid-
      // stream, and knex sends BEGIN/COMMIT/ROLLBACK as plain SQL text
      // through that exact same generic path as every other query. Because
      // this adapter also shares one `Connection` instance across every
      // `acquire()` call (see above), even the fallback idea of issuing raw
      // "BEGIN"/"COMMIT" through plain `execute()` calls on the assumption
      // that the connection's own session-affinity header would thread them
      // together is unsound: two logically-unrelated callers would be
      // mutating that same instance's one `this.session` field concurrently,
      // so a rollback could land on a session a completely different query
      // reassigned in the meantime — silently committing the wrong thing
      // rather than rolling back. There is no path from this adapter's
      // `execute()`-only surface to the package's real transaction API, so
      // this is `false`, not the `true` an earlier draft assumed.
      transactions: false,
    },

    async acquire(): Promise<TidbConnection> {
      if (conn) return conn
      let serverless: typeof import('@tidbcloud/serverless')
      try {
        serverless = await import('@tidbcloud/serverless')
      } catch {
        throw CfKnexError.missingDriver('@tidbcloud/serverless')
      }
      // `fetch` is the ambient global, resolved at call time — this is what
      // lets a test stub `globalThis.fetch` before calling `acquire()` (see
      // test/unit/tidb-http.test.ts) and is also what makes this adapter
      // work unmodified inside a Workers isolate, where `fetch` is already
      // the platform's own implementation.
      conn = serverless.connect({ url: opts.url, fetch }) as unknown as TidbConnection
      return conn
    },

    // No socket, no file descriptor, no server-side session this adapter
    // holds open — each `execute()` call above is already a complete,
    // independent HTTP request/response. For a stateless HTTP client like
    // this one, doing nothing here *is* closing the handle; there is
    // nothing left to release.
    async release(): Promise<void> {},

    async execute(handle, sql, bindings): Promise<RawResult> {
      const result: unknown = await (handle as TidbConnection).execute(sql, bindings, { fullResult: true })
      return toRawResult(result)
    },

    // Idempotent: tolerates being called more than once (e.g. `knex.destroy()`
    // called twice), same as ending an already-ended connection a second
    // time is safe. Clearing the cached connection rather than latching a
    // "destroyed" flag leaves `acquire()` free to open a new one afterward,
    // exactly as it did before this call.
    async destroy(): Promise<void> {
      conn = null
    },

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
 * src/adapters/mysql2.ts's `toRawResult` does.
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
    affectedRows: full.rowsAffected ?? undefined,
  }
}

/**
 * The package's own `FullResult.lastInsertId` type is `string | null`
 * (dist/index.d.ts) — confirmed at the source too: dist/index.js's
 * `Connection.execute()` reads it straight off the raw HTTP JSON body as
 * `resp?.sLastInsertID`, never through any numeric parsing, presumably so
 * that TiDB's `AUTO_RANDOM` and 64-bit auto-increment ids — both of which
 * routinely exceed `Number.MAX_SAFE_INTEGER` — never round-trip through a
 * precision-lossy JSON/JS number first. Converting that string straight to
 * `bigint` (rather than `Number(id)`, which would silently corrupt exactly
 * the large ids this exists to protect) mirrors src/adapters/mysql2.ts's own
 * handling of mysql2's equivalent numeric-string case. The `number` branch
 * below is not reachable through the real package (its type never offers a
 * plain `number` here) — it exists only so a hand-built `RawResult`-shaped
 * mock in a test is passed through unchanged rather than needlessly widened
 * to `bigint`.
 */
function normalizeInsertId(id: string | number | null | undefined): bigint | number | undefined {
  if (id === null || id === undefined) return undefined
  return typeof id === 'string' ? BigInt(id) : id
}
