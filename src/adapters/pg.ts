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
  //
  // Naming alone does not make two overlapping streams on one connection
  // safe, though — see the `RELEASE SAVEPOINT` reasoning inside `stream()`'s
  // own comment below for the *savepoint* half of that (distinct names do
  // not stop `RELEASE SAVEPOINT` from cascading across them).
  let cursorSeq = 0

  // How many `stream()` calls (below) are currently mid-teardown on a given
  // handle — incremented the moment a `stream()` call starts, decremented
  // only after its own `finally` block has fully finished. A *count*, not a
  // membership flag, because more than one `stream()` can be mid-teardown on
  // the exact same handle at once: nothing stops a caller starting a second
  // `trx(t2).stream()` before awaiting the first, inside one
  // `db.transaction()` callback, and each overlapping call runs this
  // generator concurrently on the one connection the transaction shares. A
  // `Set` cannot represent that — `add()` is idempotent, so two overlapping
  // calls collapse to one membership entry, and whichever finishes *first*
  // deletes it while the second is still live, reopening the race below for
  // the still-running one. Reproduced live, deterministically, 3/3: with a
  // `Set`, `validate()` read `false` while both streams were open, then
  // flipped to `true` the instant the first of the two finished even though
  // the second was still mid-teardown — the exact gap a `Map<handle,
  // number>` closes, since `has()` only reports `false` once the count
  // returns to zero.
  //
  // Exists because of two distinct premature-release races in knex itself,
  // not in this adapter — one outside a transaction, one inside:
  //
  // Outside `db.transaction()`: `Runner.stream()`
  // (node_modules/knex/lib/execution/runner.js) registers `stream.on('close',
  // () => this.client.releaseConnection(this.connection))` on the output
  // Transform at creation time, and Node's `Readable` async-iterator
  // protocol destroys that Transform — firing 'close' — the instant a
  // consumer stops early (a `break` inside `for await (const row of
  // db(t).stream())`), with *no* dependency on whether this generator's own
  // cleanup (the `finally` block below: `CLOSE`, `ROLLBACK TO SAVEPOINT` /
  // `COMMIT`) has even started, let alone finished. That is a *second*,
  // earlier connection-release path, entirely separate from the correctly-
  // ordered one `Runner.ensureConnection`'s own `finally { await
  // this.client.releaseConnection(...) }` performs only after awaiting
  // `_stream()`'s returned promise (src/core/client.ts's `_stream()` —
  // see its own comment for why *that* await is real).
  //
  // Inside `db.transaction()`, that specific Transform-'close' path is
  // neutralized, not a threat: `makeTxClient`
  // (node_modules/knex/lib/execution/transaction.js) overrides
  // `trxClient.releaseConnection` with a no-op (`() =>
  // Promise.resolve()`) precisely so a per-query `Runner` — which is
  // constructed against `trxClient`, not the base client, for every
  // `trx(...)` call — can never hand the shared transaction connection back
  // to the pool mid-transaction. But `Transaction.prototype.acquireConnection`
  // (same file) has its *own*, separate `finally` block that calls the real,
  // *base* client's `releaseConnection` — the one that actually reaches
  // tarn — once the transaction callback's returned promise settles *and*
  // the resulting `commit()`/`rollback()` has fully resolved, with no
  // dependency on whether some other, still-unawaited `trx(...).stream()`
  // call on that same connection has finished its own cleanup yet. Same
  // shape of race, different trigger. (This corrects an earlier version of
  // this comment, and this task's report, that described the Transform-
  // 'close' path itself as applying "unconditionally, including inside
  // `db.transaction()`" — it does not; the transactional exposure is real
  // but runs through `Transaction.acquireConnection`, not that handler.)
  //
  // Both paths ultimately reach the same place: tarn's `Pool.js` `release()`
  // moves the handle to `free` and, if another caller is already waiting,
  // synchronously hands it straight out — meaning a concurrent
  // `db.transaction()` (or even this same client's very next query, per the
  // existing "leaves the connection/pool usable afterward" integration
  // test) can receive and start issuing queries on this *exact* connection
  // while this generator's own CLOSE/ROLLBACK-TO-SAVEPOINT/COMMIT calls are
  // still in flight on it — reproduced directly: an unrelated query issued
  // shortly after an early `break`, against a single-connection pool,
  // measurably serializes behind whatever this generator's own abandoned
  // cursor loop and cleanup were still doing on that connection, rather than
  // running independently.
  //
  // tarn calls its configured `validate` function — wired straight through
  // to this adapter's own `validate()` below (src/core/client.ts's
  // `validateConnection`) — on every single handout attempt, both the
  // synchronous hand-to-a-waiting-caller path just described and a later,
  // ordinary `acquire()` finding this same handle sitting free
  // (node_modules/.pnpm/tarn@3.1.2's Pool.js: `_doAcquire` always calls
  // `_validateResource` before ever resolving a pending acquire), and a
  // failed validation permanently evicts the handle — `_destroy()`, mapped
  // to this adapter's own `release()` — rather than ever handing it out.
  // That ordering is unconditional, not best-effort, so marking a handle
  // here for the exact span any `stream()` call might still be issuing
  // queries on it closes the race regardless of timing: nobody can be
  // handed this connection while the count says so. Confirmed live via a
  // real knex Client wired the same way (acquireRawConnection/
  // destroyRawConnection/validateConnection — no import of this project's
  // own source, since the race is entirely in knex/tarn's mechanics, not
  // this adapter's): with the mark checked, the premature release is
  // rejected, the handle is evicted and a fresh one created for the waiting
  // caller instead, and the previously-serialized independent query runs
  // immediately and independently.
  //
  // Losing this race to eviction (tarn calling this adapter's own
  // `release()` — `client.end()` — while this generator's `finally` block
  // still has a query in flight on the same handle) is an expected outcome
  // once the gate is doing its job, not a new failure mode: `client.end()`
  // force-destroys the socket without hanging even with an active query
  // (node_modules/.pnpm/pg's `Client.prototype.end()`), postgres itself
  // rolls back an unfinished transaction the moment its connection drops,
  // and `stream()`'s own early-exit branch below already treats its cleanup
  // as best-effort for exactly this reason.
  //
  // Not cleared by `release()`/`destroy()` below — a handle that reaches
  // either of those while still present here would leak its entry forever,
  // holding a strong reference to an ended `Client`. Harmless in practice
  // (this generator's own `finally` always runs and always removes its
  // entry, even when `client.end()` races ahead and destroys the socket
  // underneath it — pg rejects any in-flight query on a torn-down connection
  // rather than hanging, node_modules/.pnpm/pg's `Client.js:198-204` — so
  // the `finally` block still completes, just via caught rejections instead
  // of successful queries), but not something to rely on by construction:
  // both `release()` and `destroy()` below also delete this handle's entry,
  // so a hypothetical future path that closes a handle without this
  // generator's own `finally` ever running (an abandoned iterator that is
  // never driven to completion, for instance) cannot poison it permanently.
  const handlesMidTeardown = new Map<PgClientShim, number>()

  function markMidTeardown(client: PgClientShim): void {
    handlesMidTeardown.set(client, (handlesMidTeardown.get(client) ?? 0) + 1)
  }

  function unmarkMidTeardown(client: PgClientShim): void {
    const next = (handlesMidTeardown.get(client) ?? 0) - 1
    if (next <= 0) handlesMidTeardown.delete(client)
    else handlesMidTeardown.set(client, next)
  }

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
      // Drops any lingering `handlesMidTeardown` entry for this exact
      // handle too — see that `Map`'s own comment above for why this isn't
      // load-bearing today (this generator's own `finally` always clears its
      // own entry, even when `client.end()` races ahead of it) but is kept
      // as a backstop against a hypothetical future path that could close a
      // handle without ever running that `finally`.
      handlesMidTeardown.delete(client)
      await client.end()
    },

    // See the `PgClientInternals` comment above for why `_queryable` alone
    // is the correct, non-redundant liveness signal: it is the exact flag
    // pg's own `Client.query()` gates on, set permanently false by the same
    // handler that emits 'error'. `_ending`/`_ended` close the separate gap
    // between a handle this adapter itself has already started closing
    // (`release()`/`destroy()` in flight) and one postgres or the network
    // killed out from under it. `handlesMidTeardown` closes a third, distinct
    // gap — a handle that is still perfectly alive, but whose `stream()`
    // cleanup (below) has not finished issuing its own queries yet, thanks
    // to knex's own premature-release race — see the `handlesMidTeardown`
    // comment above for why tarn checking this on every handout attempt is
    // what actually closes that race, not just narrows it.
    validate(handle: unknown): boolean {
      const client = handle as unknown as PgClientInternals
      return client._queryable && !client._ending && !client._ended && !handlesMidTeardown.has(handle as PgClientShim)
    },
    // (`handlesMidTeardown.has(...)` above is unchanged by the `Set` ->
    // `Map<handle, number>` switch: a `Map`'s `has()` already reports
    // `false` once an entry's count has been decremented back out of
    // existence — see the `Map`'s own comment for why a plain `Set` was
    // wrong for the case of two overlapping `stream()` calls on one handle.)

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
    // The `finally` block below is deliberately not the same calls
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
    // throw.
    //
    // Nowhere in this block issues `RELEASE SAVEPOINT` any more, on either
    // outcome — a deliberate removal, not an oversight. The version this
    // replaced did, unconditionally, on the success path, and that is
    // exactly what let two overlapping `stream()` calls sharing one
    // connection (nothing stops a caller from starting a second `trx(t2)
    // .stream()` before awaiting the first, inside one `db.transaction()`
    // callback — each gets its own numbered savepoint via `cursorSeq` above,
    // but the savepoints themselves nest: the second is created *inside* the
    // first's scope) corrupt each other: confirmed live, `RELEASE SAVEPOINT`
    // on the *outer* (earlier-created) savepoint while the *inner* one is
    // still open implicitly releases the inner one too, as a side effect —
    // postgres's own cascading-release semantics, not a bug in the release
    // call itself — so when that inner stream's own generator later reaches
    // its own `RELEASE SAVEPOINT`, postgres has nothing left to release:
    // SQLSTATE 3B001 ("savepoint … does not exist"), which — because it is a
    // *failing statement*, not a no-op — also aborts the whole shared
    // transaction (25P02 on the very next query), taking down every sibling
    // stream and whatever else the caller's transaction was doing, not just
    // the one that happened to call `RELEASE SAVEPOINT` second. Simply never
    // releasing sidesteps the entire class of bug rather than trying to
    // order around it (ordering is exactly what "overlapping, unawaited"
    // means there is none of): a savepoint nobody explicitly releases is not
    // a leak — postgres reclaims every savepoint created inside a
    // transaction, at any nesting depth, in one step, the moment that
    // transaction's own outer `COMMIT` or `ROLLBACK` runs, regardless of how
    // many are still open or in what order they were created — confirmed
    // live for every all-succeed shape this method can produce: the plain
    // dangling-savepoint case, and two dangling siblings finishing in either
    // order.
    //
    // `ROLLBACK TO SAVEPOINT` on the failure path is not removed alongside
    // `RELEASE`: unlike `RELEASE`, it is the one statement that actually
    // undoes postgres's aborted-transaction state after a failed
    // `DECLARE`/`FETCH`, with no equivalent the eventual outer
    // `COMMIT`/`ROLLBACK` could stand in for — without it, every later query
    // on that connection (a sibling stream's own next `FETCH`, or the
    // transaction's own eventual `COMMIT`) would itself fail with 25P02.
    // Keeping it is *not*, however, a complete fix for one sibling failing
    // while another is still open on the same connection — confirmed live,
    // and this is a known, currently-unfixed limitation, not a "confirmed
    // safe" case: postgres's savepoints are a single linear stack ordered by
    // *creation time*, not a tree that mirrors which `stream()` call
    // logically owns which one. `ROLLBACK TO SAVEPOINT` always undoes
    // everything created *after* the named savepoint — so if the failing
    // stream's own savepoint happens to be the *earlier* of the two (it
    // started first), its `ROLLBACK TO SAVEPOINT` on failure destroys the
    // still-open sibling's cursor as a side effect, exactly like the
    // `RELEASE SAVEPOINT` cascade above, just via a call this method cannot
    // remove. Reproduced live: sibling B's savepoint created before sibling
    // A's cursor is declared, B then fails (division by zero) and runs
    // `ROLLBACK TO SAVEPOINT` on its own (earlier) savepoint — A's next
    // `FETCH` then fails with `cursor "…" does not exist` (SQLSTATE 34000),
    // and if nothing recovers the transaction after that, a caller's
    // eventual `COMMIT` does not throw at all: postgres silently executes it
    // as a `ROLLBACK` instead (confirmed live — the `Result`'s own `command`
    // field reads `'ROLLBACK'`, not `'COMMIT'`, and a row inserted earlier in
    // the same transaction was not persisted). A caller who thinks their
    // transaction committed can lose real, uncontested work with no error at
    // all.
    //
    // Gating `ROLLBACK TO SAVEPOINT` on "no sibling stream currently open on
    // this handle" — cheap now that `handlesMidTeardown` above is a refcount
    // — was considered and rejected: it does not protect the sibling, it
    // only changes which error the sibling eventually sees. The shared
    // connection is already in postgres's transaction-wide aborted state the
    // instant *any* concurrent statement on it fails — that is not scoped to
    // whichever savepoint caused it — so skipping the recovery statement
    // just leaves every other query on that connection, including the
    // sibling's own next `FETCH`, failing immediately with 25P02 instead of
    // eventually with "cursor does not exist" once something else recovers
    // the transaction. Either way the sibling's work is lost; only the
    // error message changes. Actually protecting a sibling from a failing
    // stream needs each concurrently-open stream on its own connection
    // instead of whatever connection the caller's transaction happens to be
    // on — a materially different design, out of scope here. Overlapping,
    // unawaited streams sharing one transaction connection are safe when
    // all of them succeed (the case this method's own tests cover); a
    // caller that cannot rule out one of them failing should not overlap
    // them on a shared transaction connection — await each stream before
    // starting the next instead.
    //
    // The three-way branch below (`failed` / `completed` / neither) is what
    // early exit needs that a plain boolean cannot express. An early exit —
    // this generator's own consumer (`_stream()`) stops pulling before the
    // cursor is exhausted — reaches this `finally` block through the
    // ordinary `for-await-of` teardown path (an abandoned loop's iterator
    // gets `.return()` called on it, which resumes this generator at its
    // current suspension point as a `return`), which looks, from inside this
    // `try` block, identical to the `for (;;)` loop falling through its own
    // `break` — except that `completed` is only ever set on that natural
    // fallthrough, never on an externally-triggered `return`, so `!failed &&
    // !completed` is exactly "a consumer walked away" and nothing else.
    // Stopping early because a consumer lost interest is not a failure —
    // the fetched-so-far work is real and should still land, not roll back
    // — but it is *not* treated identically to a normal, still-attached
    // finish either: nothing downstream is listening for the outcome by
    // this point (src/core/client.ts's `waitForDrain`/`StreamSinkClosed`
    // already discard it), and `handlesMidTeardown` above means this exact
    // branch is the one tarn may legitimately be racing to evict this handle
    // out from under right now, closing the connection mid-query.
    // Both are reasons this method cannot afford to surface for a normal,
    // still-attached, fully-consumed stream: a caller who *is* still
    // waiting on the result deserves to know their commit didn't happen.
    // Early-exit cleanup is therefore best-effort like the failure path,
    // while the natural-completion `COMMIT` stays unguarded like before.
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

      markMidTeardown(client)
      try {
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
        let completed = false
        try {
          await client.query(`DECLARE ${cursorName} CURSOR FOR ${sql}`, bindings)
          cursorOpen = true
          for (;;) {
            const res = await client.query(`FETCH ${FETCH_BATCH_SIZE} FROM ${cursorName}`)
            if (res.rows.length === 0) break
            yield* res.rows
          }
          completed = true
        } catch (err) {
          failed = true
          throw err
        } finally {
          if (cursorOpen) await client.query(`CLOSE ${cursorName}`).catch(() => {})
          if (failed) {
            await client.query(`ROLLBACK TO SAVEPOINT ${marker}`).catch(() => {})
            if (!nested) await client.query('ROLLBACK').catch(() => {})
          } else if (completed) {
            if (!nested) await client.query('COMMIT')
          } else {
            // Early exit — see the comment above for why this is
            // best-effort even though it's the same "everything worked"
            // outcome the `completed` branch above commits unguarded.
            if (!nested) await client.query('COMMIT').catch(() => {})
          }
        }
      } finally {
        unmarkMidTeardown(client)
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
      // Same backstop as `release()` above, for every handle this call just
      // ended directly rather than one at a time through `release()`.
      handlesMidTeardown.clear()
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
