import { CfKnexError } from '../core/errors'
import type { DriverAdapter, RawResult } from '../core/types'
import type { Client, InArgs, IntMode, ResultSet, Transaction, TransactionMode } from '@libsql/client'

/**
 * `intMode` passes through to `@libsql/client`'s `Config.intMode`, defaulting to
 * `"number"` when omitted like `createClient` itself. `RawResult.insertId` always
 * carries `lastInsertRowid` as a `bigint` regardless of `intMode` (see `toRawResult`
 * below), but reading that column back in a later `SELECT` does not: under the default
 * `"number"` mode, `@libsql/hrana-client` throws a bare `RangeError` (not
 * `CfKnexError`) for any value above `Number.MAX_SAFE_INTEGER`. Confirmed live:
 * inserting `9007199254740995n` round-trips fine through `lastInsertRowid`, but reading
 * it back throws with the default `intMode` and returns cleanly with `intMode:
 * 'bigint'`. The default is kept as `"number"` since promoting every integer column
 * would be a worse trade for the common case. Pass `intMode: 'bigint'` (or `'string'`)
 * if the schema has columns that can exceed 2^53.
 */
export type LibsqlAdapterOptions = { url: string; authToken?: string; intMode?: IntMode }

/**
 * A `DriverAdapter` over `@libsql/client` 0.17.4, for Turso and any other
 * libsql-server-compatible endpoint reached over `http:`/`https:` (`libsql:` URLs
 * normalize to one of those two in `@libsql/core/config`'s `expandConfig`). Only the
 * HTTP client has been verified end to end against a live server (the
 * `docker-compose.yml` `libsql` service, and what Turso speaks); the `ws:`/`wss:`
 * client has been verified to run real queries and reconnect transparently after a
 * dropped socket (see the "No `validate()`" comment near `execute()` below) but not
 * exercised by this project's conformance suite the way HTTP has.
 *
 * `@libsql/client`'s `exports` map picks `lib-esm/web.js` under `workerd` (a real
 * Workers deployment) and `lib-esm/node.js` under `node`/`default` (this project's own
 * vitest, and any plain-Node consumer); the two disagree on which URL schemes are
 * reachable (`node.js` falls back to a local-file sqlite3 client, `web.js` throws
 * `LibsqlError` instead, since workerd has no filesystem) — neither local-file path is
 * exercised here, and a Workers deployment of this adapter can only ever reach
 * `ws(s):`/`http(s):` regardless.
 *
 * ## One `Client` per `acquire()`, closed on `release()` — never shared
 *
 * `src/core/types.ts`'s `DriverAdapter` doc requires `acquire()` to hand back a new
 * handle every call, and `release(handle)` to permanently close the one handle it was
 * given — tarn never hands the same handle to a second caller. A single shared `Client`
 * with `release()` a no-op is wrong structurally: the first time tarn evicts any one
 * handle it believes is independent, `release()` would `.close()` the one `Client`
 * every other pooled handle secretly *is*, killing all of them. `createClient` being
 * cheap (see `acquire()`'s comment below) removes the only reason sharing might have
 * been justified.
 *
 * ## Streaming
 *
 * `capabilities.streaming` is `false`: `Client.execute()` always resolves a complete,
 * fully-buffered `ResultSet`, and the package exposes no cursor or chunked-read API
 * this adapter's optional `stream()` hook could wrap.
 *
 * ## Transactions
 *
 * `Client.execute()`'s doc says every statement runs "in its own logical database
 * connection", and `HttpClient.execute()` confirms it: it opens a Hrana stream, awaits
 * the one statement, and closes it before `execute()` resolves. Confirmed live: three
 * sequential calls, `"BEGIN"` then an `INSERT` then `"ROLLBACK"`, report the first two
 * as successes, then `ROLLBACK` rejects with "cannot rollback - no transaction is
 * active" — the `BEGIN`'s transaction ended the moment its stream closed, so the
 * `INSERT` was a plain autocommit write already durable by then. That rules out routing
 * BEGIN/COMMIT/ROLLBACK through plain `execute()` unchanged, not transactions
 * generally: `Client.transaction(mode)` opens a real session that stays open across
 * calls on the `Transaction` object it returns — confirmed live, including a
 * `ROLLBACK` that undoes an insert, a `COMMIT` that keeps one, and savepoints working
 * unmodified inside one. `execute()` below intercepts the transaction-control
 * statements knex emits and forwards everything else to the open `Transaction` instead.
 */
export function createLibsqlAdapter(opts: LibsqlAdapterOptions): DriverAdapter {
  // Handles `acquire()` has handed out that `release()` hasn't yet closed —
  // `destroy()` is the safety net for whatever's left when tarn tears down.
  const open = new Set<Client>()

  // The `Transaction` currently open on a given handle, if any — knex holds one
  // handle for a transaction's entire lifetime, so the `Transaction` outlives the
  // single `execute()` call that created it. `pendingMode` carries a `SET TRANSACTION
  // READ ONLY;` from the statement that names it to the `BEGIN;` that follows it — knex
  // always sends them as two separate calls on the same handle, in that order.
  const activeTx = new WeakMap<Client, Transaction>()
  const pendingMode = new WeakMap<Client, TransactionMode>()

  // Rolls back and forgets whatever transaction is open on `client` — shared by
  // `release()` and `destroy()`, neither of which may leave a transaction-bearing
  // handle behind. The map entry is cleared before the rollback is awaited, so it's
  // gone regardless of outcome; the rollback itself is best-effort since there's no
  // caller left to report failure to (unlike the caller-triggered COMMIT/ROLLBACK
  // inside execute() below).
  async function abandonTransaction(client: Client): Promise<void> {
    const tx = activeTx.get(client)
    if (!tx) return
    activeTx.delete(client)
    pendingMode.delete(client)
    await tx.rollback().catch(() => {})
  }

  return {
    dialect: 'sqlite',
    driver: 'libsql',
    capabilities: { streaming: false, transactions: true },

    async acquire(): Promise<Client> {
      let mod: typeof import('@libsql/client')
      try {
        mod = await import('@libsql/client')
      } catch {
        throw CfKnexError.missingDriver('@libsql/client')
      }
      // A brand-new `Client` on every call — never cached and shared (see this
      // function's doc comment above for why sharing is unsafe here). `createClient`
      // does no I/O for an `http:`/`https:` URL: it calls `hrana.openHttp` with only
      // four arguments, so `protocolVersion` defaults to `2`, which resolves the hrana
      // client's `_endpointPromise` synchronously instead of running `findEndpoint()`
      // (the function that would actually probe the server) — that only runs for
      // `protocolVersion === 3`, never selected. Confirmed by instrumenting `fetch`:
      // zero calls after construction.
      const client = mod.createClient({ url: opts.url, authToken: opts.authToken, intMode: opts.intMode })
      open.add(client)
      return client
    },

    // Tarn calls this only when permanently evicting a handle (idle timeout, pool
    // shrink, or teardown) — see `DriverAdapter` in src/core/types.ts. `open.delete`
    // before `.close()` keeps `destroy()`'s cleanup pass from double-closing this
    // client if that ever raced.
    async release(handle: unknown): Promise<void> {
      const client = handle as Client
      open.delete(client)
      // A caller who runs `db.raw('BEGIN')` (or lets a `db.transaction()` callback
      // hang) and never commits or rolls back must not hand tarn a transaction-bearing
      // handle next — see `abandonTransaction` above.
      await abandonTransaction(client)
      client.close()
    },

    // No `validate()` — omitted entirely, same as src/adapters/tidb-http.ts:
    // `createKnexClient` (../core/client.ts) treats a missing `validate` as "always
    // valid", correct for a handle that cannot go stale between queries the way a live
    // TCP socket can (contrast src/adapters/mysql2.ts's `validate`, which reads
    // internal fields on a real socket).
    //
    // `!client.closed` looks like the obvious liveness check, but confirmed live it does
    // not hold for either scheme: over HTTP, `client.closed` stayed `false` after a
    // failing statement (`SQLITE_UNKNOWN: no such table`) and a total network failure
    // (`fetch failed`) — `HttpClient.closed` forwards to the hrana client's `closed`
    // getter, which only flips via `#setClosed`, wired only to `close()` and to a
    // rejection handler on a promise `@libsql/client` never actually rejects (see
    // `acquire()`'s comment above for why); `HttpClient.reconnect()` would reset it, but
    // this adapter never calls it. Over WS, through a raw TCP proxy that killed the
    // underlying socket mid-connection, `client.closed` also stayed `false`, and the
    // *next* `execute()` call transparently reconnected and succeeded — `WsClient`
    // self-heals via an inner, non-exposed hrana client and never propagates that state
    // to the outer field this adapter could read.
    //
    // So for every scheme this adapter can reach, `.closed` reflects only whether *this
    // adapter* called `.close()`, never genuine staleness — a `validate` built on it
    // would silently never return `false` for a truly dead handle.

    // BEGIN/COMMIT/ROLLBACK/SAVEPOINT-family statements bracket a real `Transaction`
    // (see the "Transactions" doc comment above) instead of reaching
    // `client.execute()`'s isolated per-call path.
    async execute(handle, sql, bindings): Promise<RawResult> {
      const client = handle as Client
      const tx = activeTx.get(client)

      if (tx) {
        // Cleared before the `await`, not after, so a failing COMMIT/ROLLBACK still
        // ends the transaction here; the error itself still propagates unmodified.
        if (COMMIT_STATEMENT.test(sql)) {
          activeTx.delete(client)
          await tx.commit()
          return EMPTY_RESULT
        }
        if (ROLLBACK_STATEMENT.test(sql)) {
          activeTx.delete(client)
          await tx.rollback()
          return EMPTY_RESULT
        }
        // Confirmed live against both a libsql-server container and Turso:
        // SAVEPOINT/ROLLBACK TO SAVEPOINT/RELEASE SAVEPOINT need no
        // translation once a `Transaction` exists.
        return toRawResult(await tx.execute({ sql, args: bindings as unknown as InArgs }))
      }

      if (BEGIN_STATEMENT.test(sql)) {
        const mode = pendingMode.get(client) ?? 'write'
        pendingMode.delete(client)
        activeTx.set(client, await client.transaction(mode))
        return EMPTY_RESULT
      }

      // `SET TRANSACTION …;` always precedes `BEGIN;` on the same handle (knex's
      // `Transaction.prototype.begin`, node_modules/knex/lib/execution/transaction.js)
      // and never arrives once a transaction is open, so this only needs checking here.
      const setTransaction = SET_TRANSACTION_STATEMENT.exec(sql)
      const trxMode = setTransaction?.[1] ?? ''
      if (setTransaction) {
        const isolation = ISOLATION_LEVEL.exec(trxMode)
        if (isolation)
          throw CfKnexError.unsupportedTransactionMode(
            `isolation level '${isolation[1] ?? trxMode}' is not configurable on the libsql driver — SQLite is always serializable. Omit isolationLevel for this driver.`,
          )
        if (READ_ONLY_STATEMENT.test(trxMode)) {
          pendingMode.set(client, 'read')
          return EMPTY_RESULT
        }
      }

      // knex emits `SET TRANSACTION …` immediately before `BEGIN`, so a remembered mode
      // is only meant to survive one statement. Reaching any other statement first
      // means `BEGIN` never came — dropping the pending mode here stops tarn's next,
      // unrelated borrower from silently getting a 'read' transaction out of an
      // ordinary `db.transaction()`. Same fix as the remembered isolation level in
      // src/adapters/tidb-http.ts.
      pendingMode.delete(client)

      return toRawResult(await client.execute({ sql, args: bindings as unknown as InArgs }))
    },

    async destroy(): Promise<void> {
      // Closes whatever tarn never released (see the `open` comment above); clears the
      // set rather than latching a "destroyed" flag, like src/adapters/mysql2.ts's
      // `destroy()`, so it's safe to call more than once and leaves the adapter reusable.
      // Each client's transaction is abandoned first, same as `release()` does.
      for (const client of open) {
        await abandonTransaction(client)
        client.close()
      }
      open.clear()
    },
  }
}

/**
 * `execute()` always resolves a `ResultSet` that `@libsql/client` itself constructed —
 * `resultSetFromHrana` (lib-esm/hrana.js) always builds a `ResultSetImpl` with `rows`,
 * `columns`, `rowsAffected` and `lastInsertRowid` as plain properties, never partial or
 * differently shaped, unlike src/adapters/tidb-http.ts's `toRawResult`, which reads a
 * raw, untrusted HTTP body. Still worth guarding: this function's own `unknown`
 * boundary, so a future version of the package (or a test double) returning something
 * shaped differently doesn't pass silently through as a real result. Guard `rows`
 * (what every consumer iterates), `rowsAffected` (`src/core/response.ts`'s sqlite
 * branch reports it as `changes`) and `lastInsertRowid` (`insertId`, see the
 * `Number()` note below). `columns`/`columnTypes` are deliberately NOT validated:
 * `src/core/response.ts`'s sqlite branch never reads `RawResult.fields`, so a malformed
 * `columns` here flows into a field no caller consumes — passed through unchanged
 * rather than coerced to `undefined`, unlike the three fields above that throw.
 */
function toRawResult(res: unknown): RawResult {
  if (res === null || typeof res !== 'object' || !('rows' in res)) {
    throw CfKnexError.malformedResult(
      `libsql execute() did not return a ResultSet with a 'rows' field (got ${res === null ? 'null' : typeof res})`,
    )
  }
  const { rows, columns, rowsAffected, lastInsertRowid } = res as Partial<ResultSet>
  if (!Array.isArray(rows)) {
    throw CfKnexError.malformedResult(`libsql ResultSet.rows was not an array (got ${typeof rows})`)
  }
  if (typeof rowsAffected !== 'number') {
    throw CfKnexError.malformedResult(`libsql ResultSet.rowsAffected was not a number (got ${typeof rowsAffected})`)
  }
  if (lastInsertRowid !== undefined && typeof lastInsertRowid !== 'bigint') {
    throw CfKnexError.malformedResult(
      `libsql ResultSet.lastInsertRowid was neither bigint nor undefined (got ${typeof lastInsertRowid})`,
    )
  }
  return {
    rows,
    fields: columns,
    // `lastInsertRowid` is typed `bigint | undefined` so a 64-bit ROWID survives —
    // `Number()` would silently corrupt it (src/core/response.ts's sqlite branch names
    // this). Passed straight through, matching src/adapters/mysql2.ts and
    // src/adapters/tidb-http.ts; write path only — reading a >2^53 id back in a
    // `SELECT` is controlled by `intMode`, see `LibsqlAdapterOptions` above.
    insertId: lastInsertRowid,
    affectedRows: rowsAffected,
  }
}

// Anchored, case-insensitive, tolerating an optional trailing semicolon — same style
// as src/adapters/pg.ts's COMMIT_STATEMENT. Anchoring the end keeps ROLLBACK_STATEMENT
// from matching "ROLLBACK TO SAVEPOINT x" and COMMIT_STATEMENT from matching "RELEASE
// SAVEPOINT x;". knex's sqlite transaction dialect emits only `BEGIN;`, never `START
// TRANSACTION`, accepted anyway since a caller's own `db.raw()` might send it. Inner
// whitespace is `\s+` so `db.raw('START  TRANSACTION')` is still intercepted.
const BEGIN_STATEMENT = /^(?:BEGIN|START\s+TRANSACTION)\s*;?\s*$/i
const COMMIT_STATEMENT = /^COMMIT\s*;?\s*$/i
const ROLLBACK_STATEMENT = /^ROLLBACK\s*;?\s*$/i
const SET_TRANSACTION_STATEMENT = /^SET\s+TRANSACTION\s+(.+?)\s*;?\s*$/i
// knex's own `validIsolationLevels` (node_modules/knex/lib/execution/transaction.js)
// is the exhaustive list `setIsolationLevel` allows, so matching exactly these five is
// not a guess.
const ISOLATION_LEVEL = /ISOLATION\s+LEVEL\s+(READ\s+UNCOMMITTED|READ\s+COMMITTED|REPEATABLE\s+READ|SERIALIZABLE|SNAPSHOT)/i
const READ_ONLY_STATEMENT = /READ\s+ONLY/i

// What execute() returns for a transaction-control statement it intercepts instead of
// sending to libsql — no real ResultSet exists for a "BEGIN" once it's been turned
// into a `client.transaction()` call.
const EMPTY_RESULT: RawResult = { rows: [] }
