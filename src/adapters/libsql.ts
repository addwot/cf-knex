import { CfKnexError } from '../core/errors'
import type { DriverAdapter, RawResult } from '../core/types'
import type { Client, InArgs, IntMode, ResultSet, Transaction, TransactionMode } from '@libsql/client'

/**
 * `intMode` passes straight through to `@libsql/client`'s own `Config.intMode`
 * (`node_modules/@libsql/core`'s `api.d.ts`) and defaults to whatever
 * `createClient` itself defaults to when omitted — `"number"` — rather than
 * this adapter picking a different default. That default has a real
 * limitation worth knowing before hitting it in production: this project's
 * `RawResult.insertId` already carries a written row's `lastInsertRowid` as a
 * `bigint` regardless of `intMode` (see `toRawResult`'s doc comment below),
 * but *reading that same column back* in a later `SELECT` does not get the
 * same treatment — under the default `"number"` mode, `@libsql/hrana-client`
 * decodes any integer *column value* above `Number.MAX_SAFE_INTEGER` into a
 * bare `RangeError` ("Received integer which is too large to be safely
 * represented as a JavaScript number"), not a `CfKnexError`. Confirmed live:
 * inserting id `9007199254740995n` (`2^53 + 3`) against the docker container
 * round-trips correctly through `lastInsertRowid`, but `SELECT id FROM …`
 * for that same row throws exactly that `RangeError` with the default
 * `intMode`, and returns `9007199254740995n` cleanly with `intMode: 'bigint'`.
 * Changing this adapter's *default* to `'bigint'` was considered and
 * rejected — it would turn every ordinary integer column into a `bigint` for
 * every caller, a worse trade for the common case than leaving a sharp edge
 * documented for the uncommon one. Pass `intMode: 'bigint'` (or `'string'`)
 * here if the schema has integer columns that can exceed 2^53.
 */
export type LibsqlAdapterOptions = { url: string; authToken?: string; intMode?: IntMode }

/**
 * A `DriverAdapter` over `@libsql/client` 0.17.4, for Turso and any other
 * libsql-server-compatible endpoint reached over `http:`/`https:` (`libsql:`
 * URLs normalize to one of those two — `@libsql/core/config`'s
 * `expandConfig`, shared by every build below). Only the HTTP client has
 * been read and verified end to end against a live server (the
 * `docker-compose.yml` `libsql` service, and what Turso itself speaks); the
 * `ws:`/`wss:` client has been read and partially verified — proven to
 * execute real queries end-to-end and to reconnect transparently after a
 * dropped socket (see the "No `validate()`" comment below, near `execute()`,
 * for exactly what that covered) — but not exercised by this project's own
 * conformance suite the way the HTTP path has been.
 *
 * `@libsql/client` ships more than one build, and which one a given
 * `import('@libsql/client')` resolves to depends on the *consumer's*
 * bundler/runtime, not on anything this adapter controls — its own
 * `package.json` `exports` map (`node_modules/@libsql/client/package.json`)
 * picks `lib-esm/web.js` under a `workerd` condition (a real Cloudflare
 * Workers deployment of a project using this adapter) and `lib-esm/node.js`
 * under `node`/`default` (this project's own `node` vitest project, and any
 * plain-Node consumer). The two builds do not agree on which URL schemes are
 * even reachable: `node.js`'s `_createClient` sends anything that isn't
 * `ws(s):`/`http(s):` to a local-file sqlite3 client, while `web.js`'s
 * `_createClient` throws `LibsqlError` (`URL_SCHEME_NOT_SUPPORTED`) for
 * everything except `ws(s):`/`http(s):` — there is no local-file client in
 * the Workers-targeted build at all (workerd has no filesystem for it to
 * open). Neither local-file path is exercised or claimed correct by
 * anything below; a Workers deployment of this adapter can only ever reach
 * `ws(s):`/`http(s):` regardless.
 *
 * ## One `Client` per `acquire()`, closed on `release()` — never shared
 *
 * `src/core/types.ts`'s `DriverAdapter` doc is explicit about what these
 * hooks mean once wired into knex's tarn pool via `acquireRawConnection`/
 * `destroyRawConnection` (`src/core/client.ts`): `acquire()` must hand back a
 * new handle every call, and `release(handle)` permanently closes the one
 * handle it was given — tarn calls it only when evicting a resource for
 * good, never to hand the same handle to a second caller. A single shared
 * `Client`, returned by every `acquire()` with `release()` a no-op (an
 * earlier draft of this file, and the shape two other adapters in this
 * project already shipped as a Critical defect), is wrong here for a
 * structural reason, not just a style one: the first time tarn evicts *any*
 * one of the handles it believes are independent, `release()` would call
 * `.close()` on the one `Client` every other still-pooled handle secretly
 * *is* — killing all of them, not just the one being evicted. `createClient`
 * being cheap (see `acquire()`'s own comment below for exactly how cheap,
 * confirmed by instrumenting `fetch` rather than assumed) removes the only
 * reason that might have justified sharing anyway.
 *
 * ## Streaming
 *
 * `capabilities.streaming` is `false`: `Client.execute()`
 * (node_modules/@libsql/client/lib-esm/http.js) always resolves a complete,
 * fully-buffered `ResultSet` — `const rowsResult = await rowsPromise; return
 * resultSetFromHrana(rowsResult)` — and the package exposes no cursor or
 * chunked-read API this adapter's optional `stream()` hook could wrap.
 *
 * ## Transactions
 *
 * Per-call isolation is why the naive path fails, and it is a property of
 * the API rather than an artifact of transport:
 * `Client.execute()`'s own doc comment (node_modules/@libsql/client's
 * re-exported `@libsql/core/api`'s `Client` interface) says every statement
 * it runs "is executed in its own logical database connection", and reading
 * `HttpClient.execute()` (lib-esm/http.js) shows that's not a metaphor — it
 * opens a Hrana stream, awaits the one statement, and closes that stream
 * before `execute()` even resolves. Confirmed live against the docker
 * container: three sequential `execute()` calls, `"BEGIN"` then an `INSERT`
 * then `"ROLLBACK"`, report `BEGIN` and the `INSERT` as successes, then
 * `ROLLBACK` rejects with `LibsqlError: SQLITE_UNKNOWN: SQLite error: cannot
 * rollback - no transaction is active` — the `BEGIN`'s transaction ended
 * the moment its own stream closed, so the `INSERT` after it was a plain
 * autocommit write, already durable by the time `ROLLBACK` discovers there
 * is nothing left to undo.
 *
 * That rules out routing BEGIN/COMMIT/ROLLBACK through plain `execute()`
 * unchanged; it does not rule out transactions. `Client.transaction(mode)`
 * opens a real session that stays open across multiple calls on the
 * `Transaction` object it returns — confirmed live, including a `ROLLBACK`
 * that actually undoes an insert, a `COMMIT` that keeps one, and savepoints
 * (`SAVEPOINT`/`ROLLBACK TO SAVEPOINT`/`RELEASE SAVEPOINT`) working
 * unmodified inside one. `execute()` below intercepts the transaction-
 * control statements knex emits and, once a `Transaction` exists for a
 * handle, forwards everything else straight to it instead of to the
 * isolated per-call path described above.
 */
export function createLibsqlAdapter(opts: LibsqlAdapterOptions): DriverAdapter {
  // Every `Client` this adapter's `acquire()` has handed out that `release()`
  // hasn't yet closed — the same bookkeeping `src/adapters/mysql2.ts` keeps
  // for its TCP connections. `destroy()` below is the safety net for
  // whatever's left in here once tarn has released everything it currently
  // holds; under normal operation that should usually be empty by then.
  const open = new Set<Client>()

  // The `Transaction` currently open on a given handle, if any — knex holds
  // one handle for a transaction's entire lifetime, which is what lets a
  // `Transaction` object outlive the single `execute()` call that created it.
  // `pendingMode` carries a `SET TRANSACTION READ ONLY;` from the statement
  // that names it to the `BEGIN;` that follows it (see D3 in this adapter's
  // execute() below) — knex always sends them as two separate calls on the
  // same handle, in that order, before any transaction exists for it.
  const activeTx = new WeakMap<Client, Transaction>()
  const pendingMode = new WeakMap<Client, TransactionMode>()

  // Rolls back and forgets whatever transaction is open on `client`, if any —
  // shared by `release()` and `destroy()` below, both of which must not hand
  // or leave a transaction-bearing handle behind them. The map entry is
  // cleared before the rollback is even awaited, so it is gone regardless of
  // whether that rollback succeeds; the rollback itself is best-effort here
  // (unlike the caller-triggered COMMIT/ROLLBACK inside execute() below,
  // whose own failure must still reach the caller) because there is no
  // caller left to report it to at this point.
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
      // A brand-new `Client` on every call — never one cached and shared;
      // see this function's doc comment above for why sharing is actually
      // unsafe here, not merely unnecessary. `createClient` does no I/O at
      // all for an `http:`/`https:` URL: `HttpClient`'s constructor
      // (node_modules/@libsql/client/lib-esm/http.js) stores the URL/token
      // and calls `hrana.openHttp(url, token, fetch, remoteEncryptionKey)` —
      // four arguments, so the fifth, `protocolVersion`, takes its declared
      // default of `2` (node_modules/@libsql/hrana-client/lib-esm/index.js's
      // `openHttp`). Inside `hrana`'s own `HttpClient` constructor
      // (node_modules/@libsql/hrana-client/lib-esm/http/client.js), that
      // `protocolVersion !== 3` takes the constructor down its `else`
      // branch, which resolves `_endpointPromise` synchronously —
      // `Promise.resolve(fallbackEndpoint)` — with no `fetch` call at all;
      // `findEndpoint()` (the function that *would* probe the server, via a
      // real `fetch`) only runs in the `protocolVersion === 3` branch, which
      // `@libsql/client` never selects. An earlier draft of this comment
      // claimed a background probe ran here anyway; it doesn't — confirmed
      // by instrumenting `globalThis.fetch` around `createClient()` and
      // observing zero calls in the 300ms after construction, against the
      // same docker container this file's other live checks use.
      const client = mod.createClient({ url: opts.url, authToken: opts.authToken, intMode: opts.intMode })
      open.add(client)
      return client
    },

    // Tarn calls this only when permanently evicting a handle (idle
    // timeout, pool shrink, or the whole pool tearing down) — see the
    // `DriverAdapter` doc comment in src/core/types.ts. `open.delete` before
    // `.close()` keeps `destroy()`'s own cleanup pass from double-closing
    // this same client if that ever raced.
    async release(handle: unknown): Promise<void> {
      const client = handle as Client
      open.delete(client)
      // A caller who runs `db.raw('BEGIN')` (or lets a `db.transaction()`
      // callback hang) and never commits or rolls back must not hand a
      // transaction-bearing handle to whatever tarn does with it next — see
      // `abandonTransaction` above.
      await abandonTransaction(client)
      client.close()
    },

    // No `validate()` — omitted entirely, the same way
    // src/adapters/tidb-http.ts omits it, and for the same underlying
    // reason: `createKnexClient` (../core/client.ts) treats a missing
    // `validate` as "always valid", which is correct for a handle that
    // cannot go stale between queries the way a live TCP socket can (contrast
    // src/adapters/mysql2.ts's `validate`, which reads four internal fields
    // on a real socket).
    //
    // An earlier draft of this file implemented `validate` as `!client.closed`
    // (the interface doc for `Client.closed` reads: "set to true after a
    // call to close or if the client encounters an unrecoverable error," which
    // sounds like exactly the liveness signal `validate` needs). Read against
    // the actual field this adapter's handle exposes, that turned out not to
    // hold for either URL scheme this adapter can reach:
    //
    // - HTTP (`http:`/`https:`/`libsql:`): confirmed live against the docker
    //   container — `client.closed` stayed `false` after a failing statement
    //   (`SQLITE_UNKNOWN: no such table`) and after a total network failure
    //   (`fetch failed`, against a closed port). The mechanism, stated
    //   precisely rather than loosely (this field is what the earlier,
    //   now-removed comment misdescribed as a background probe elsewhere in
    //   this file, so it's worth being exact here too): `@libsql/client`'s
    //   `HttpClient.closed` (lib-esm/http.js:205-207) is a getter that
    //   forwards to the underlying hrana client's own `closed` getter
    //   (@libsql/hrana-client/lib-esm/http/client.js:100), which reads a
    //   private `#closed` field written only by `#setClosed` (same file,
    //   :103). `#setClosed` has three call sites: `close()` (:97, this
    //   adapter's own call) and an `_endpointPromise` rejection handler wired
    //   on *both* constructor branches (:52 for `protocolVersion === 3`, :56
    //   for the `else` branch `@libsql/client` always takes — see
    //   `acquire()`'s comment above for why). The taken branch's handler can
    //   never fire — it is attached to `Promise.resolve(fallbackEndpoint)`
    //   (:55), which has no rejection path; only the v3 branch attaches it to
    //   a real `findEndpoint()` fetch (:51), and that branch is never
    //   selected. So neither call site fires for a statement failure or a
    //   network failure. `HttpClient`'s `reconnect()` (lib-esm/http.js:192) would
    //   reset `closed` by rebuilding the underlying hrana client, but this
    //   adapter never calls it — `execute()` below calls `Client.execute()`
    //   directly, never `reconnect()`.
    // - WS (`ws:`/`wss:`): also confirmed live, through a raw TCP proxy in
    //   front of the same server so the underlying socket could be destroyed
    //   out from under an established connection (something not otherwise
    //   reachable against a container shared with other agents). After the
    //   proxy killed the socket, `client.closed` still read `false`, and the
    //   *next* `execute()` call transparently reconnected and succeeded —
    //   `WsClient`'s own `#openStream()` (node_modules/@libsql/client/
    //   lib-esm/ws.js) checks an *inner*, non-exposed hrana client's `closed`
    //   flag to self-heal, but never propagates that to the outer field this
    //   adapter could read. (The one place in that file where a `closed`
    //   getter *does* forward socket state — `lib-esm/ws.js`'s `WsTransaction`
    //   class — belongs to the object `Client.transaction()` returns, not to
    //   the plain `Client`/`WsClient` handle `acquire()` below hands out; it
    //   was checked and ruled out as a source of liveness for this adapter's
    //   handle specifically.)
    //
    // So for every scheme this adapter can actually be pointed at, `.closed`
    // reflects only whether *this adapter* has called `.close()` — never
    // genuine staleness — and a `validate` built on it would silently never
    // return `false` for a truly dead handle, the opposite of what `validate`
    // exists for.

    // BEGIN/COMMIT/ROLLBACK/SAVEPOINT-family statements bracket a real
    // `Transaction` (see this file's "Transactions" doc comment above)
    // instead of reaching `client.execute()`'s isolated per-call path.
    // `activeTx`/`pendingMode` above are keyed by the handle because knex
    // holds one handle for a transaction's entire lifetime.
    async execute(handle, sql, bindings): Promise<RawResult> {
      const client = handle as Client
      const tx = activeTx.get(client)

      if (tx) {
        // Cleared before the `await`, not after, so a failing COMMIT/ROLLBACK
        // still ends the transaction as far as this adapter is concerned —
        // the error itself still propagates to the caller, unmodified.
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
        // Everything else, including every savepoint statement: confirmed
        // live against both a libsql-server container and Turso that
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

      // `SET TRANSACTION …;` always precedes `BEGIN;` on the same handle —
      // see knex's own `Transaction.prototype.begin`
      // (node_modules/knex/lib/execution/transaction.js) — never arrives
      // once a transaction is already open, so this only needs checking here.
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

      return toRawResult(await client.execute({ sql, args: bindings as unknown as InArgs }))
    },

    async destroy(): Promise<void> {
      // Closes whatever this adapter created that tarn never released (see
      // the `open` comment above) and leaves the adapter itself reusable
      // afterward — clearing the set rather than latching a "destroyed"
      // flag, exactly like src/adapters/mysql2.ts's `destroy()`. Safe to
      // call more than once (the `DriverAdapter` contract requires it):
      // `HttpClient.close()` (node_modules/@libsql/hrana-client's
      // `HttpClient`) guards itself with `#setClosed`, which returns
      // immediately if the client is already closed, so re-closing an
      // already-closed client here is a no-op, not a double-free. Each
      // client's transaction, if any, is abandoned first — see
      // `abandonTransaction` above — the same reasoning `release()` applies
      // to a single handle, applied here to whatever `destroy()` itself is
      // closing directly.
      for (const client of open) {
        await abandonTransaction(client)
        client.close()
      }
      open.clear()
    },
  }
}

/**
 * `execute()` above always resolves a `ResultSet` that `@libsql/client`
 * itself constructed — `resultSetFromHrana`
 * (node_modules/@libsql/client/lib-esm/hrana.js) always builds a
 * `ResultSetImpl` (node_modules/@libsql/core's `util.js`) with `rows`,
 * `columns`, `rowsAffected` and `lastInsertRowid` as plain properties, never
 * a partial or differently-shaped object — there is no untrusted JSON
 * boundary here the way there is in src/adapters/tidb-http.ts's `toRawResult`
 * (that adapter reads a raw HTTP response body directly; this one reads
 * whatever the installed, already-parsed `@libsql/client` package handed
 * back). What *is* still worth guarding is the boundary this function itself
 * sits at: `handle`/`res` are `unknown` until cast, so a future version of
 * this package, or a test double standing in for one, that returns something
 * shaped differently would otherwise pass silently through as if it were a
 * real result — exactly the silently-wrong-success failure this project has
 * repeatedly found in adapter code. Guard `rows` (what every downstream
 * consumer iterates), `rowsAffected` (what `src/core/response.ts`'s sqlite
 * branch reports as `changes`) and `lastInsertRowid` (`insertId` — see the
 * `Number()` note below); deliberately do NOT also validate `columns`/
 * `columnTypes` the way src/adapters/tidb-http.ts's `toRawResult` validates
 * every field it reads: `src/core/response.ts`'s sqlite branch (unlike its
 * mysql/postgres branches) never reads `RawResult.fields` at all, so a
 * malformed `columns` array here would flow into a field no current caller
 * consumes rather than corrupting anything observable — so `columns` below
 * is passed straight through as `fields` unchanged, not coerced to
 * `undefined` if it's not an array, which would sit inconsistently next to
 * three fields above that throw instead of coercing.
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
    // `ResultSet.lastInsertRowid` is typed `bigint | undefined` precisely so
    // a 64-bit ROWID survives — src/core/response.ts's sqlite branch already
    // documents this by name for libsql: "insertId is left as `number |
    // bigint` — no `Number()` — because ... libsql's bigint `lastInsertRowid`
    // ... would be silently corrupted by a float conversion." Pass the
    // `bigint` straight through, matching src/adapters/mysql2.ts and
    // src/adapters/tidb-http.ts's own normalization toward `bigint` for the
    // same reason. This only covers the write path: reading a >2^53 id back
    // in a later `SELECT`'s row *values* is a separate concern, controlled by
    // `intMode` and not by anything here — see `LibsqlAdapterOptions.intMode`'s
    // doc comment above for the read-back limitation and how to opt out of it.
    insertId: lastInsertRowid,
    affectedRows: rowsAffected,
  }
}

// Anchored, case-insensitive, tolerating an optional trailing semicolon —
// same style as src/adapters/pg.ts's COMMIT_STATEMENT. Anchoring the end is
// what keeps ROLLBACK_STATEMENT from matching "ROLLBACK TO SAVEPOINT x" and
// COMMIT_STATEMENT from matching "RELEASE SAVEPOINT x;" — knex sends the
// former without a trailing semicolon, so it's optional here, not required.
// knex's own sqlite transaction dialect (node_modules/knex/lib/dialects/
// sqlite3/execution/sqlite-transaction.js) emits only `BEGIN;` and never
// `START TRANSACTION`, which is accepted anyway for whatever a caller's own
// `db.raw()` sends. Inner whitespace is `\s+` rather than a literal space so
// a caller's `db.raw('START  TRANSACTION')` is intercepted rather than
// silently falling through to the isolated per-call path.
const BEGIN_STATEMENT = /^(?:BEGIN|START\s+TRANSACTION)\s*;?\s*$/i
const COMMIT_STATEMENT = /^COMMIT\s*;?\s*$/i
const ROLLBACK_STATEMENT = /^ROLLBACK\s*;?\s*$/i
const SET_TRANSACTION_STATEMENT = /^SET\s+TRANSACTION\s+(.+?)\s*;?\s*$/i
// knex's own `validIsolationLevels` (node_modules/knex/lib/execution/
// transaction.js) is the exhaustive list of values `setIsolationLevel` ever
// lets through — it throws before generating any SQL for anything outside
// this list, so matching exactly these five is not a guess.
const ISOLATION_LEVEL = /ISOLATION\s+LEVEL\s+(READ\s+UNCOMMITTED|READ\s+COMMITTED|REPEATABLE\s+READ|SERIALIZABLE|SNAPSHOT)/i
const READ_ONLY_STATEMENT = /READ\s+ONLY/i

// What execute() returns for a transaction-control statement it intercepts
// instead of sending to libsql — no real ResultSet exists for "BEGIN"
// once it's been turned into a `client.transaction()` call, so nothing here
// should look like one.
const EMPTY_RESULT: RawResult = { rows: [] }
