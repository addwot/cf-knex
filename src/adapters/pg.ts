import { CfKnexError } from '../core/errors'
import type { Credentials, DriverAdapter, RawResult } from '../core/types'

/**
 * `pg` ships no type declarations of its own for this version: no `types`/
 * `typings` field in node_modules/pg/package.json, and no `.d.ts` file
 * anywhere under node_modules/pg (`find node_modules/pg -iname '*.d.ts'`
 * returns nothing) — unlike mysql2, which ships a full `.d.ts` that
 * src/adapters/mysql2.ts imports real types from. This project also has no
 * `@types/pg` dependency. test/pg.d.ts already declares the ambient module
 * the node integration project's smoke test needs — a default export
 * exposing a bare `Client` constructor — and, because TypeScript's ambient
 * module declarations are program-wide rather than file-scoped, that same
 * declaration is what lets `await import('pg')` below type-check at all.
 * Everything past that bare constructor shape is a local shim, the same
 * pattern src/adapters/mysql2.ts uses for the mysql2 members its own `.d.ts`
 * doesn't resolve — covering every member this adapter actually calls,
 * typed as closely to pg's real runtime shape as the missing upstream types
 * allow.
 */
type PgClientShim = {
  connect(): Promise<void>
  query(sql: string, values?: unknown[]): Promise<PgResult>
  end(): Promise<void>
  on(event: 'error', listener: (err: Error) => void): void
}

/**
 * The subset of pg's own `Client` internal state (node_modules/pg/lib/
 * client.js) `validate()` below reads to decide whether a pooled handle is
 * still usable. None of these three fields are part of any public pg type
 * (there isn't one for this version — see above) and all three are
 * underscore-prefixed / undocumented, the same class of "private but
 * load-bearing" field src/adapters/mysql2.ts's `RawMysql2Connection` reads
 * off mysql2.
 *
 * `_queryable` is the one that matters: it is the *exact* flag pg's own
 * `Client.query()` checks before accepting a new query (lib/client.js:700,
 * `if (!this._queryable) { ...'Client has encountered a connection error
 * and is not queryable' }`), and it is set to `false` exactly once,
 * permanently, inside `_handleErrorEvent` (lib/client.js:411-418) — the
 * same handler that emits the client's 'error' event for a dead socket
 * (`_handleErrorEvent` sets `_queryable = false` and *then* calls
 * `this.emit('error', err)`, in that order). Reading it directly means
 * `validate()` asks pg the same question pg asks itself before running a
 * query, rather than re-deriving liveness from a second, independently
 * maintained flag — unlike mysql2's adapter, which combines an internal-
 * state check with its own `dead` WeakSet as two independently sufficient
 * signals (mysql2's fields are read one layer below the promise wrapper and
 * don't, on their own, cover every path that can kill a connection). pg's
 * `_queryable` has no such gap: every way a live, already-connected `Client`
 * stops being usable — a socket error, a fatal backend message — routes
 * through `_handleErrorEvent`, so a second tracking mechanism here would
 * only reproduce what this one field already guarantees.
 *
 * `_ending`/`_ended` cover the other way a handle stops being usable:
 * `_ending` flips `true` synchronously inside `Client.end()`
 * (lib/client.js:734-735), before the `.end()` promise this adapter's own
 * `release()`/`destroy()` awaits even resolves; `_ended` flips `true` once
 * the underlying connection's 'end' event has actually fired
 * (lib/client.js:203). Neither on its own covers the gap between "told to
 * close" and "actually closed" — reading both does.
 */
type PgClientInternals = {
  _queryable: boolean
  _ending: boolean
  _ended: boolean
}

/**
 * pg's own `Result` shape (node_modules/pg/lib/result.js), narrowed to the
 * fields this adapter reads. Verified directly against a live postgres
 * (`docker compose`'s `postgres:16` service): a real `Result` always carries
 * `command` and `rows` — `rows` is `[]`, never omitted, for DDL and
 * non-RETURNING DML alike, and `command` is populated identically for
 * `SELECT`/`INSERT`/`UPDATE`/`DELETE` and for `CREATE`/`DROP` (schema
 * statements), which matters because `toKnexResponse`
 * (src/core/response.ts) throws `CfKnexError.malformedResult` on a falsy
 * `command` rather than defaulting it — see `toRawResult` below for the
 * empirical values observed.
 */
type PgResult = {
  command?: unknown
  rowCount?: unknown
  rows: unknown[]
  fields?: unknown[]
}

/**
 * The one field this adapter reads off a Hyperdrive-style config, whether
 * that's a real Cloudflare `Hyperdrive` binding or a plain object shaped
 * like one. A real binding carries five credential fields too (`host`,
 * `port`, `user`, `password`, `database`) alongside `connectionString` —
 * deliberately not declared here, and not read, even though pg's `Client`
 * constructor would happily accept them. See `resolveConfig` below for why
 * reading them would be actively wrong for pg specifically, not just
 * unnecessary.
 */
type HyperdriveConfig = { connectionString: string }

export type PgAdapterOptions = {
  url?: string
  connection?: Credentials
  hyperdrive?: HyperdriveConfig
}

/**
 * Exported so a test can assert directly on its output shape rather than
 * only through a live connection — see the comment above `hyperdriveFrom` in
 * test/integration/pg.test.ts for why a live connection genuinely cannot
 * distinguish this function's hyperdrive branch from `{ ...opts.hyperdrive }`
 * when the shim's `connectionString` and its five discrete fields describe
 * the same address (pg's own `ConnectionParameters` overwrites the discrete
 * fields with whatever `parse(connectionString)` returns regardless of which
 * one this function handed it, so both shapes reach `pg.Client` carrying
 * identical values in that case). A structural assertion on this function's
 * *return value*, before any of it reaches pg, has no such blind spot.
 */
export function resolveConfig(opts: PgAdapterOptions): Record<string, unknown> {
  if (opts.hyperdrive) {
    // Explicit destructure of exactly the one field this adapter wants, not
    // `{ ...opts.hyperdrive }`: a real Cloudflare `Hyperdrive` binding
    // carries six own-enumerable properties (host, port, user, password,
    // database, connectionString), and pg's own `ConnectionParameters`
    // constructor (node_modules/pg/lib/connection-parameters.js:59-61) does
    // this unconditionally whenever `config.connectionString` is set:
    //
    //   if (config.connectionString) {
    //     config = Object.assign({}, config, parse(config.connectionString))
    //   }
    //
    // — the parsed connection string is assigned OVER whatever explicit
    // fields were already on `config`, last-write-wins, regardless of which
    // one is actually correct. `pg-connection-string`'s own `parse()`
    // always emits every one of `user`/`password`/`host`/`port`/`database`
    // (verified directly: `parse('postgres://user@127.0.0.1:5432')` — no
    // path, no password — returns `{ user: 'user', password: '', host:
    // '127.0.0.1', port: '5432', database: null }`, not a partial object
    // missing the keys it can't fill), so a spread binding doesn't merely
    // risk this in some edge case — the clobber is unconditional the moment
    // both `connectionString` and the five credential fields sit on the
    // same config object, on every single connection. Reading only
    // `connectionString` and handing pg nothing else sidesteps the
    // mechanism entirely rather than hoping the two representations always
    // agree.
    const { connectionString } = opts.hyperdrive
    return { connectionString }
  }
  if (opts.connection) {
    // Unlike src/adapters/mysql2.ts, `Credentials.ssl` needs no translation
    // here — leave it exactly as `Credentials` declares it (`boolean |
    // undefined`) and pass it straight through. mysql2's
    // `ConnectionOptions.ssl` setter throws synchronously on a literal
    // boolean (see that file's `credentialsToConnectionOptions` comment);
    // pg's does not. `ConnectionParameters`'s constructor
    // (connection-parameters.js:85) reads `config.ssl` straight through —
    // `this.ssl = typeof config.ssl === 'undefined' ?
    // readSSLConfigFromEnvironment() : config.ssl` — and the only later
    // special-casing (lines 87-91) is for a *string* value ('true' /
    // 'no-verify'); a boolean passes through both untouched. Verified
    // empirically too, against this same pg version: `new pg.Client({ ...,
    // ssl: true })` and `ssl: false` both construct without throwing — the
    // TypeError mysql2 raises for the same input has no pg equivalent. This
    // divergence from the mysql2 adapter is deliberate, not an oversight:
    // do not "fix" it into matching mysql2's `ssl ? {} : {}` translation,
    // which pg does not need and which would silently replace a caller's
    // `ssl: { rejectUnauthorized: false }`-shaped object with `{}` if this
    // file were ever edited to mirror mysql2's spread-then-override pattern
    // carelessly.
    return { ...opts.connection }
  }
  if (opts.url) return { connectionString: opts.url }
  throw new CfKnexError('NO_CONNECTION', "pg adapter needs one of 'url', 'connection' or 'hyperdrive'")
}

// Row batch size for the `FETCH` loop inside `stream()` below — how many
// rows cross the wire per round trip, not a cap on total rows streamed.
// Unremarkable and not tuned for this task; a caller with different memory/
// latency tradeoffs has no way to override it today.
const FETCH_BATCH_SIZE = 100

export function createPgAdapter(opts: PgAdapterOptions): DriverAdapter {
  const config = resolveConfig(opts)

  // Every connection this adapter has handed out via `acquire()` that
  // hasn't yet been closed via `release()` — see src/adapters/mysql2.ts's
  // identical `open` set for the full reasoning. Under normal operation
  // tarn calls `release()` (src/core/client.ts's `destroyRawConnection`)
  // for every handle it holds before `destroy()` ever runs, so this should
  // usually be empty by then; `destroy()` below is the safety net for
  // whatever's left.
  const open = new Set<PgClientShim>()

  // `stream()` below names every savepoint/cursor it creates
  // `cf_knex_sp_<n>` / `cf_knex_cur_<n>` off this counter, shared across
  // every connection this adapter instance ever hands out. A fixed literal
  // name instead of this would collide the moment two `stream()` calls
  // overlap on the same connection (a caller not awaiting one `.stream()`
  // before starting another inside the same `db.transaction()` callback) —
  // confirmed directly, live: declaring a second cursor with a name already
  // open on the same connection fails with `cursor "…" already exists`
  // (SQLSTATE 42P03). A plain incrementing integer sidesteps this
  // (guaranteed distinct for the process's lifetime) and, since it is never
  // built from caller input, gives a SQL-injection surface no chance to
  // exist in the first place — the identifier is 100% this adapter's own
  // text.
  let cursorSeq = 0

  return {
    dialect: 'postgres',
    driver: 'pg',
    capabilities: { streaming: true, transactions: true },

    async acquire(): Promise<PgClientShim> {
      let pgDefault: { Client: unknown }
      try {
        pgDefault = (await import('pg')).default
      } catch {
        throw CfKnexError.missingDriver('pg')
      }
      // The ambient `Client` type (test/pg.d.ts) is deliberately narrow —
      // `new (...args: never[]) => unknown` — because that file only needs
      // to prove the export is a constructor, never to call one. This
      // adapter does need to call one, with a real config object, so the
      // constructor reference is re-typed here against the locally-declared
      // shape this file actually relies on, the same "cast through
      // `unknown`, then narrow to a local shim" pattern
      // src/adapters/mysql2.ts uses for members its own `.d.ts` doesn't
      // resolve.
      const PgClient = pgDefault.Client as unknown as new (config: unknown) => PgClientShim
      // A brand-new `Client` on every call — never one cached and shared.
      // `createKnexClient` wires this into knex's `acquireRawConnection()`,
      // which tarn calls only when it needs an additional pooled resource
      // (bounded by pool size, not query count), and `db.transaction()`
      // holds whichever connection it receives for its entire lifetime.
      // Handing the same `Client` to two callers would let an unrelated
      // query land on the same postgres session as an open transaction —
      // see src/adapters/mysql2.ts's `acquire()` comment for the full
      // version of this reasoning; it applies identically here.
      const client = new PgClient(config)
      await client.connect()
      open.add(client)
      // `Client` is an `EventEmitter` (node_modules/pg/lib/client.js:
      // `class Client extends EventEmitter`) and emits 'error' the moment
      // the socket dies post-connect (`_handleErrorEvent`, lib/client.js:
      // 411-418 — see the `PgClientInternals` comment above). Node's
      // EventEmitter throws on an unhandled 'error' event by default, which
      // would crash the whole isolate the first time a pooled, currently-
      // idle connection hits a network blip. This listener exists solely to
      // guard that — unlike src/adapters/mysql2.ts's equivalent listener,
      // it does not also need to *mark* the handle dead for `validate()`
      // below: `_handleErrorEvent` already flips `_queryable` to `false`
      // (synchronously, before it emits 'error' at all), so `validate()`
      // reads that flag directly instead of a second, adapter-maintained
      // one.
      client.on('error', () => {})
      return client
    },

    // Called when tarn permanently evicts this handle — see the
    // `DriverAdapter` doc comment in src/core/types.ts for why "release"
    // means "close" at this layer, not "return to the pool". `open.delete`
    // before `.end()` keeps `destroy()`'s cleanup pass from double-ending
    // this handle if tarn's own bookkeeping ever called both.
    async release(handle: unknown): Promise<void> {
      const client = handle as PgClientShim
      open.delete(client)
      await client.end()
    },

    // See the `PgClientInternals` comment above for why `_queryable` alone
    // is the correct, non-redundant liveness signal: it is the exact flag
    // pg's own `Client.query()` gates on, set permanently false by the same
    // handler that emits 'error'. `_ending`/`_ended` close the separate gap
    // between a handle this adapter itself has already started closing
    // (`release()`/`destroy()` in flight) and one postgres or the network
    // killed out from under it.
    validate(handle: unknown): boolean {
      const client = handle as unknown as PgClientInternals
      return client._queryable && !client._ending && !client._ended
    },

    async execute(handle, sql, bindings): Promise<RawResult> {
      const client = handle as PgClientShim
      const res = await client.query(sql, bindings)
      return toRawResult(res)
    },

    // Row-by-row streaming for `db(table).stream()`, over a real server-side
    // cursor (`DECLARE … CURSOR FOR` / `FETCH` / `CLOSE`) rather than
    // buffering the whole result — the entire reason `.stream()` exists as a
    // capability distinct from `execute()`. src/core/client.ts's `_stream()`
    // drives this generator with its own `for await`, writing each yielded
    // row into knex's output stream and awaiting backpressure there.
    //
    // Cursors only exist inside a transaction, and postgres requires
    // `BEGIN` first if the connection is not already inside one — but
    // whether it already is depends on the caller: a plain `db(t).stream()`
    // hands this method a fresh, idle connection, while `db.transaction(trx
    // => trx(t).stream())` hands it a connection already mid-transaction
    // (the same one the whole callback shares). Issuing `BEGIN`
    // unconditionally, without checking which case this is, is genuinely
    // dangerous, not just redundant: postgres does not reject a nested
    // `BEGIN` (it only emits a NOTICE, "there is already a transaction in
    // progress" — confirmed live), so nothing signals the mistake, and this
    // method's own teardown would then `COMMIT` a transaction it did not
    // open — ending the *caller's* transaction early. Confirmed live: with
    // an outer `BEGIN` and an uncommitted insert already issued, running
    // this sequence nested inside it and letting it reach its own `COMMIT`
    // made the outer, still-in-progress insert visible to a second
    // connection immediately — before the outer caller ever committed
    // anything itself.
    //
    // Detecting "already in a transaction" needs to be both correct across
    // every pg version this package supports (`peerDependencies.pg` is
    // `>=8.11.0`) and not itself racy. `Client.prototype.getTransactionStatus()`
    // fails both: it does not exist before pg 8.21.0 (an older peer would
    // throw `TypeError: client.getTransactionStatus is not a function` the
    // first time `.stream()` ran), and even on a version that has it, it can
    // read stale, one-message-behind state immediately after an awaited
    // query's own promise has already rejected — reproduced directly:
    // reading it right after a caught `DECLARE` failure returned "T"
    // (nominally still fine) on one run and "E" (aborted) on another,
    // for the identical code path, because `_handleReadyForQuery`
    // (node_modules/pg/lib/client.js) updates that field from a separate,
    // later protocol message than the one that rejects the query's promise.
    // What this method uses instead needs no version-gated API and no
    // separately-timed message: attempt `SAVEPOINT <marker>` with nothing
    // before it. Postgres itself answers the nested-or-not question as a
    // side effect of that one statement — no probe query, no extra round
    // trip in the already-in-a-transaction case: it succeeds if a
    // transaction is already open (and `<marker>` is now a real savepoint
    // this method can roll back to or release later), or fails with
    // SQLSTATE 25P01 ("SAVEPOINT can only be used in transaction blocks")
    // if not, confirmed live on a fresh idle connection — a stable,
    // documented error code, not translatable NOTICE/error text this method
    // would otherwise have to match locale-sensitively. Only the not-
    // already-in-a-transaction branch issues `BEGIN`, and only after that
    // negative has actually been confirmed.
    //
    // The `finally` block below is deliberately not the same three calls
    // regardless of outcome. The original shape this replaced — an
    // unconditional `CLOSE` then `COMMIT`, every time, success or failure —
    // masks the *real* error on any failure: confirmed live, once `DECLARE`
    // (or a `FETCH`) fails, the transaction enters postgres's aborted state,
    // and an unguarded `CLOSE` issued after that fails too, with SQLSTATE
    // 25P02 ("current transaction is aborted, commands ignored until end of
    // transaction block") — thrown from inside an unguarded `finally` block,
    // that replaces whatever the actually-useful original error was (a
    // missing table, a bad column, …) with this generic one, and the caller
    // never learns what really went wrong. This method tracks whether the
    // work actually failed and branches on it: failure-path cleanup
    // (`CLOSE`, `ROLLBACK TO SAVEPOINT`, the outer `ROLLBACK` when this
    // method opened its own transaction) is best-effort — each swallows its
    // own error — specifically so a secondary failure while cleaning up
    // can never replace the original rejection this generator must still
    // throw; success-path cleanup (`RELEASE SAVEPOINT`, the outer `COMMIT`)
    // is not swallowed, because silently failing to commit successful work
    // would be a different, equally real version of the same bug the
    // above avoids the other way round: a caller told nothing went wrong
    // when the work was, in fact, never durably finished. An early exit —
    // this generator's own consumer (`_stream()`) stops pulling before the
    // cursor is exhausted — reaches the same `finally` block through the
    // ordinary `for-await-of` teardown path (an abandoned loop's iterator
    // gets `.return()` called on it, which resumes this generator at its
    // current suspension point as a `return`), with `failed` left `false`:
    // stopping early because a consumer lost interest is not a failure, and
    // the fetched-so-far work is real work that should still be committed,
    // not rolled back.
    //
    // Bind params inside `DECLARE … CURSOR FOR <select>` (as opposed to a
    // plain `execute()`-style query): confirmed live — `DECLARE cur CURSOR
    // FOR SELECT * FROM t WHERE id > $1 AND id < $2` with values `[1, 4]`
    // resolved both placeholders correctly. Postgres parses and plans the
    // wrapped statement the same way whether or not a `DECLARE … CURSOR FOR`
    // sits in front of it, so this needs no different handling from
    // `execute()`'s own `client.query(sql, bindings)` call above.
    async *stream(handle, sql, bindings) {
      const client = handle as PgClientShim
      const marker = `cf_knex_sp_${++cursorSeq}`
      const cursorName = `cf_knex_cur_${cursorSeq}`

      let nested: boolean
      try {
        await client.query(`SAVEPOINT ${marker}`)
        nested = true
      } catch (err) {
        if ((err as { code?: string }).code !== '25P01') throw err
        nested = false
        await client.query('BEGIN')
        await client.query(`SAVEPOINT ${marker}`)
      }

      let cursorOpen = false
      let failed = false
      try {
        await client.query(`DECLARE ${cursorName} CURSOR FOR ${sql}`, bindings)
        cursorOpen = true
        for (;;) {
          const res = await client.query(`FETCH ${FETCH_BATCH_SIZE} FROM ${cursorName}`)
          if (res.rows.length === 0) break
          yield* res.rows
        }
      } catch (err) {
        failed = true
        throw err
      } finally {
        if (cursorOpen) await client.query(`CLOSE ${cursorName}`).catch(() => {})
        if (failed) {
          await client.query(`ROLLBACK TO SAVEPOINT ${marker}`).catch(() => {})
          // Tidiness, not correctness: confirmed live that the transaction
          // is already healthy again right after `ROLLBACK TO SAVEPOINT`
          // alone, with or without this. Best-effort for the same reason as
          // the rest of this block — it must never be the call that ends up
          // masking the original error.
          await client.query(`RELEASE SAVEPOINT ${marker}`).catch(() => {})
          if (!nested) await client.query('ROLLBACK').catch(() => {})
        } else {
          await client.query(`RELEASE SAVEPOINT ${marker}`)
          if (!nested) await client.query('COMMIT')
        }
      }
    },

    async destroy(): Promise<void> {
      // Ends whatever this adapter created that tarn never released — see
      // the `open` comment above for when that's non-empty — and leaves the
      // adapter itself reusable afterward (clearing the set, not latching a
      // "destroyed" boolean, is what keeps `acquire()` free to open new
      // connections afterward — same reasoning as src/adapters/mysql2.ts's
      // `destroy()`).
      await Promise.all([...open].map((client) => client.end()))
      open.clear()
    },
  }
}

/**
 * Guards the boundary where this adapter hands a driver-shaped result back
 * to `toKnexResponse` (src/core/response.ts). Confirmed empirically against
 * a live postgres (`docker compose`'s `postgres:16` service) rather than
 * assumed from pg's docs:
 *
 * - `insert into t (name) values ($1)` with no `.returning()`: `{ command:
 *   'INSERT', rowCount: 1, rows: [] }` — not iterable, not an array; this is
 *   exactly the shape that made `const [id] = await db(table).insert(...)`
 *   throw a `TypeError` before test/support/conformance.ts's postgres
 *   branch was written to ask for `.returning('id')` instead (see that
 *   file's comment on the dialect-aware first case).
 * - `create table` / `drop table`: `{ command: 'CREATE' | 'DROP', rowCount:
 *   null, rows: [], fields: [] }` — `command` is populated exactly like
 *   DML, `rowCount` is `null` (not `0`, not omitted).
 * - `update` / `delete`: `{ command: 'UPDATE' | 'DELETE', rowCount: <n>,
 *   rows: [] }`.
 *
 * A well-formed `Result` therefore always carries a `rows` array (`toKnexResponse`'s
 * SELECT/RETURNING paths depend on that) and a `command` string
 * (`toKnexResponse`'s postgres branch throws `CfKnexError.malformedResult`
 * itself if that one is falsy — deliberately, per that file's comment, so a
 * missing `command` fails loudly instead of silently misreporting a
 * DELETE/UPDATE row count as `[]`). Guarding both here, one layer earlier,
 * catches the same failure at its actual source — pg handing back something
 * that isn't a `Result` at all — with a message that says what this adapter
 * saw, rather than a generic one three files away. `rowCount` is `number |
 * null` on a real `Result` (see the CREATE/DROP case above); mapping `null`
 * to `undefined` here, rather than forwarding it as-is, keeps
 * `RawResult.affectedRows`'s contract (`number`, optional — never `null`)
 * uniform across all four adapters instead of pg alone leaking a `null`
 * through it.
 */
function toRawResult(res: unknown): RawResult {
  if (res === null || typeof res !== 'object' || !Array.isArray((res as { rows?: unknown }).rows)) {
    throw CfKnexError.malformedResult(
      `pg query did not return a Result with a 'rows' array (got ${res === null ? 'null' : typeof res})`,
    )
  }
  const result = res as PgResult
  if (typeof result.command !== 'string' || result.command.length === 0) {
    throw CfKnexError.malformedResult(`pg query result had no 'command' string (got ${typeof result.command})`)
  }
  return {
    rows: result.rows,
    fields: result.fields ?? [],
    command: result.command,
    affectedRows: typeof result.rowCount === 'number' ? result.rowCount : undefined,
  }
}
