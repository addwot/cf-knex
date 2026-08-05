import { CfKnexError } from '../core/errors'
import type { DriverAdapter, RawResult } from '../core/types'
import type { Client, InArgs, IntMode, ResultSet } from '@libsql/client'

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
 * ## Transactions — verified `false` against a live server, not assumed
 *
 * Two independent facts, each read from the installed package and then
 * confirmed against the live `libsql` container this project's
 * `docker-compose.yml` starts (`LIBSQL_URL=http://127.0.0.1:8080`), rule out
 * routing knex's BEGIN/COMMIT/ROLLBACK through this adapter's plain
 * `execute(handle, sql, bindings)` surface — regardless of whether one
 * `Client` is shared or a fresh one is handed out per `acquire()` (settled
 * separately above; it doesn't matter for this question either way):
 *
 * 1. `Client.execute()`'s own doc comment
 *    (node_modules/@libsql/client's re-exported `@libsql/core/api`'s
 *    `Client` interface) states it plainly: "Every statement executed with
 *    this method is executed in its own logical database connection." Read
 *    at the source, that's not a metaphor —
 *    `HttpClient.execute()` (lib-esm/http.js) opens a brand new Hrana
 *    stream for the single statement (`const stream =
 *    this.#client.openStream()`), awaits its result, and closes that same
 *    stream (`stream.closeGracefully()`) before `execute()` even resolves.
 *    Every call, including one for the literal text `"BEGIN"`, gets its own
 *    stream that is already closed by the time the *next* `execute()` call
 *    — the actual query a transaction would wrap — opens a completely
 *    unrelated one.
 * 2. That closing isn't a harmless implementation detail — a stream is
 *    where the server-side transaction this package's own interactive
 *    `Client.transaction()`/`Transaction` API depends on actually lives
 *    (`HttpTransaction` in the same file keeps its stream open across
 *    multiple `.execute()` calls on the `Transaction` object specifically
 *    *because* closing it ends whatever transaction it was in). Sending
 *    "BEGIN" through the plain, per-call-isolated `Client.execute()` above
 *    begins a transaction on a stream that is gone before the function
 *    returns.
 *
 * Confirmed live, not just read: three sequential `client.execute()` calls —
 * `"BEGIN"`, an `INSERT`, then `"ROLLBACK"` — issued on one shared `Client`
 * against the docker container reproduced exactly the failure mode implied
 * above, and it is the worst one this package's contract has. The `ROLLBACK`
 * call itself rejected with `LibsqlError: SQLITE_UNKNOWN: SQLite error:
 * cannot rollback - no transaction is active` (the `BEGIN`'s transaction had
 * already ended when its own stream closed), and the row inserted "inside"
 * that supposedly-rolled-back transaction was still present afterward — a
 * plain autocommit `INSERT`, not a rollback that silently no-ops but a
 * rollback that silently *cannot even be attempted*, with the write it was
 * meant to undo already durable. `capabilities.transactions: false` reports
 * that faithfully instead of letting `db.transaction()` promise atomicity
 * this driver, reached this way, cannot provide.
 *
 * `hints.transactions` below points at this package's real atomic
 * primitives — `Client.batch()` and `Client.transaction()` — because they
 * exist and are genuinely the fix, unlike a driver with no such option at
 * all: neither is reachable through `DriverAdapter`'s `execute(handle, sql,
 * bindings)` surface (there is no hook here for "this call is actually a
 * batch" or "hold this stream open across calls"), so getting real
 * atomicity means calling `@libsql/client` directly, outside this adapter.
 */
export function createLibsqlAdapter(opts: LibsqlAdapterOptions): DriverAdapter {
  // Every `Client` this adapter's `acquire()` has handed out that `release()`
  // hasn't yet closed — the same bookkeeping `src/adapters/mysql2.ts` keeps
  // for its TCP connections. `destroy()` below is the safety net for
  // whatever's left in here once tarn has released everything it currently
  // holds; under normal operation that should usually be empty by then.
  const open = new Set<Client>()

  return {
    dialect: 'sqlite',
    driver: 'libsql',
    capabilities: { streaming: false, transactions: false },
    hints: {
      transactions:
        "Each execute() call runs on its own, immediately-closed connection (see src/adapters/libsql.ts's doc comment for the live-verified evidence), so BEGIN/COMMIT/ROLLBACK issued through db.transaction() cannot share one. For real atomicity, call @libsql/client's own Client.batch() or Client.transaction() directly, outside cf-knex.",
    },

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

    async execute(handle, sql, bindings): Promise<RawResult> {
      const client = handle as Client
      const res = await client.execute({ sql, args: bindings as unknown as InArgs })
      return toRawResult(res)
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
      // already-closed client here is a no-op, not a double-free.
      for (const client of open) client.close()
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
