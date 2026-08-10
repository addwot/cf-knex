import { CfKnexError } from '../core/errors'
import type { Credentials, DriverAdapter, RawResult } from '../core/types'

/**
 * `pg` ships no type declarations for this version (no `types`/`typings`
 * field, no `.d.ts` under node_modules/pg, no `@types/pg`). The ambient
 * module in test/pg.d.ts — a default export exposing a bare `Client`
 * constructor — is what lets `await import('pg')` below type-check at all,
 * since TS ambient declarations are program-wide, not file-scoped. Past
 * that bare shape, this is a local shim, the same pattern
 * src/adapters/mysql2.ts uses, covering every member this adapter calls.
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
 * still usable. All three are underscore-prefixed / undocumented, the same
 * class of "private but load-bearing" field src/adapters/mysql2.ts's
 * `RawMysql2Connection` reads off mysql2.
 *
 * `_queryable` is the exact flag pg's own `Client.query()` checks before
 * accepting a new query (lib/client.js:700), set to `false` exactly once,
 * permanently, inside `_handleErrorEvent` (lib/client.js:411-418) — the
 * same handler that emits 'error', and does so *after* flipping the flag.
 * Reading it directly means `validate()` asks pg the same question pg asks
 * itself, unlike mysql2's adapter, which needs its own `dead` WeakSet
 * alongside an internal-state check because mysql2's fields don't alone
 * cover every path that can kill a connection.
 *
 * `_ending`/`_ended` cover the other way a handle stops being usable:
 * `_ending` flips `true` synchronously inside `Client.end()` (lib/client.js:
 * 734-735), before the `.end()` promise this adapter's own `release()`/
 * `destroy()` awaits even resolves; `_ended` flips `true` once the
 * underlying connection's 'end' event has actually fired (lib/client.js:
 * 203). Neither alone covers the gap between "told to close" and "actually
 * closed" — reading both does.
 */
type PgClientInternals = {
  _queryable: boolean
  _ending: boolean
  _ended: boolean
}

/**
 * pg's own `Result` shape (node_modules/pg/lib/result.js), narrowed to the
 * fields this adapter reads. Verified against a live postgres: a real
 * `Result` always carries `command` and `rows` — `rows` is `[]`, never
 * omitted, for DDL and non-RETURNING DML alike, and `command` is populated
 * identically for DML and for `CREATE`/`DROP` — which matters because
 * `toKnexResponse` (src/core/response.ts) throws on a falsy `command`
 * rather than defaulting it. See `toRawResult` below for the values observed.
 */
type PgResult = {
  command?: unknown
  rowCount?: unknown
  rows: unknown[]
  fields?: unknown[]
}

/**
 * The one field this adapter reads off a Hyperdrive-style config. A real
 * binding also carries five credential fields (`host`, `port`, `user`,
 * `password`, `database`) alongside `connectionString` — deliberately not
 * declared here, and not read. See `resolveConfig` below for why reading
 * them would be actively wrong for pg specifically, not just unnecessary.
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
 * test/integration/pg.test.ts for why a live connection cannot distinguish
 * this function's hyperdrive branch from `{ ...opts.hyperdrive }` (pg's own
 * `ConnectionParameters` overwrites discrete fields with whatever
 * `parse(connectionString)` returns, so both shapes reach `pg.Client`
 * identically when the address matches). A structural assertion on the
 * return value, before any of it reaches pg, has no such blind spot.
 */
export function resolveConfig(opts: PgAdapterOptions): Record<string, unknown> {
  if (opts.hyperdrive) {
    // Explicit destructure of exactly the one field this adapter wants, not
    // `{ ...opts.hyperdrive }`: pg's own `ConnectionParameters` constructor
    // (node_modules/pg/lib/connection-parameters.js:59-61) unconditionally
    // does `config = Object.assign({}, config, parse(config.connectionString))`
    // whenever `config.connectionString` is set, overwriting the binding's
    // five discrete credential fields last-write-wins — verified directly:
    // `parse('postgres://user@127.0.0.1:5432')` returns a full `{ user,
    // password, host, port, database }` object, not a partial one, so the
    // clobber is unconditional whenever both shapes are present. Reading
    // only `connectionString` sidesteps the mechanism entirely.
    const { connectionString } = opts.hyperdrive
    return { connectionString }
  }
  if (opts.connection) {
    // Unlike src/adapters/mysql2.ts, `Credentials.ssl` needs no translation
    // here — pass it straight through. mysql2's `ConnectionOptions.ssl`
    // setter throws synchronously on a literal boolean; pg's does not
    // (`ConnectionParameters`'s constructor reads `config.ssl` straight
    // through, only special-casing a *string* value). Verified empirically:
    // `new pg.Client({ ..., ssl: true })` and `ssl: false` both construct
    // without throwing. Deliberate divergence — do not "fix" it to match
    // mysql2's `ssl ? {} : {}` translation, which would silently replace a
    // caller's `ssl: { rejectUnauthorized: false }`-shaped object with `{}`.
    return { ...opts.connection }
  }
  if (opts.url) return { connectionString: opts.url }
  throw new CfKnexError('NO_CONNECTION', "pg adapter needs one of 'url', 'connection' or 'hyperdrive'")
}

// Row batch size for the `FETCH` loop inside `stream()` below — how many
// rows cross the wire per round trip, not a cap on total rows streamed. A
// plain default; not currently caller-overridable.
const FETCH_BATCH_SIZE = 100

export function createPgAdapter(opts: PgAdapterOptions): DriverAdapter {
  const config = resolveConfig(opts)

  // Every connection handed out via `acquire()` not yet closed via
  // `release()` — see src/adapters/mysql2.ts's identical `open` set for the
  // full reasoning. Normally empty by the time `destroy()` runs; that
  // method is the safety net for whatever's left.
  const open = new Set<PgClientShim>()

  // `stream()` below names every savepoint/cursor it creates
  // `cf_knex_sp_<n>` / `cf_knex_cur_<n>` off this counter, shared across
  // every connection this adapter instance ever hands out. A fixed literal
  // name would collide the moment two `stream()` calls overlap on the same
  // connection — confirmed live: declaring a second cursor with a name
  // already open fails with `cursor "…" already exists` (SQLSTATE 42P03). A
  // plain incrementing integer sidesteps this and, never built from caller
  // input, leaves no SQL-injection surface. Naming alone does not make
  // overlapping streams safe, though — see the `RELEASE SAVEPOINT`
  // reasoning inside `stream()`'s own comment below.
  let cursorSeq = 0

  // How many `stream()` calls (below) are currently mid-teardown on a given
  // handle — incremented when a call starts, decremented only after its own
  // `finally` fully finishes. A count, not a membership flag: an unawaited
  // second `trx(t2).stream()` inside one `db.transaction()` callback can be
  // mid-teardown on the same handle as a first, and a `Set` collapses both
  // to one entry — reproduced live, 3/3: with a `Set`, `validate()` flipped
  // `true` the instant the first of two overlapping streams finished, even
  // though the second was still mid-teardown; a `Map<handle, number>`'s
  // `has()` only goes false once the count returns to zero.
  //
  // Exists because knex itself has two premature-release races that can
  // hand this connection to another caller while this generator's own
  // CLOSE/ROLLBACK-TO-SAVEPOINT/COMMIT cleanup is still in flight on it:
  // outside a transaction, `Runner.stream()`
  // (node_modules/knex/lib/execution/runner.js) releases the connection
  // the instant a consumer stops early, independent of whether this
  // generator's cleanup has started; inside `db.transaction()`, that exact
  // path is neutralized (`makeTxClient` no-ops `releaseConnection`), but
  // `Transaction.prototype.acquireConnection`'s own `finally` releases the
  // base connection once the transaction callback settles, with no
  // dependency on whether some other unawaited `trx(...).stream()` on it
  // has finished cleanup — reproduced directly: an unrelated query
  // serializes behind this generator's abandoned cleanup instead of
  // running independently.
  //
  // tarn calls this adapter's `validate()` on every handout attempt,
  // including the synchronous hand-off both races reach through tarn's
  // `Pool.js` `release()`, and a failed validation permanently evicts the
  // handle. Marking a handle here for the span any `stream()` call might
  // still be querying it therefore closes the race regardless of timing —
  // confirmed live via a real knex Client wired the same way. Losing this
  // race to eviction is expected, not a new failure: `client.end()`
  // force-destroys without hanging, postgres rolls back an unfinished
  // transaction on disconnect, and the early-exit branch below already
  // treats its own cleanup as best-effort for the same reason.
  //
  // Not relied on being cleared by `release()`/`destroy()` below — this
  // generator's own `finally` always removes its entry regardless — but
  // both also delete it as a backstop against a future path that could
  // close a handle without that `finally` running.
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
      // `new (...args: never[]) => unknown` — since that file only needs to
      // prove the export is a constructor. This adapter needs to call one
      // with a real config, so the reference is re-typed here against the
      // locally-declared shape it relies on, the same "cast through
      // `unknown`, then narrow" pattern src/adapters/mysql2.ts uses.
      const PgClient = pgDefault.Client as unknown as new (config: unknown) => PgClientShim
      // A brand-new `Client` on every call, never shared: `db.transaction()`
      // holds whichever connection it receives for its entire lifetime, and
      // handing the same `Client` to two callers would let an unrelated
      // query land on the same postgres session as an open transaction —
      // see src/adapters/mysql2.ts's `acquire()` comment for the full
      // reasoning.
      const client = new PgClient(config)
      await client.connect()
      open.add(client)
      // `Client` is an `EventEmitter` and emits 'error' the moment the
      // socket dies post-connect (`_handleErrorEvent`, see the
      // `PgClientInternals` comment above); Node throws on an unhandled
      // 'error' by default, crashing the isolate the first time an idle
      // pooled connection hits a network blip. Unlike mysql2's equivalent
      // listener, this one doesn't also need to mark the handle dead for
      // `validate()`: `_handleErrorEvent` already flips `_queryable` false.
      client.on('error', () => {})
      return client
    },

    // Called when tarn permanently evicts this handle — see the
    // `DriverAdapter` doc comment in src/core/types.ts for why "release"
    // means "close" here, not "return to the pool". `open.delete` before
    // `.end()` keeps `destroy()`'s cleanup pass from double-ending this
    // handle if tarn's own bookkeeping ever called both.
    async release(handle: unknown): Promise<void> {
      const client = handle as PgClientShim
      open.delete(client)
      // Backstop for a hypothetical future path that could close a handle
      // without `stream()`'s own `finally` running — see the `Map`'s own
      // comment above for why this normally isn't load-bearing.
      handlesMidTeardown.delete(client)
      await client.end()
    },

    // See the `PgClientInternals` comment above for why `_queryable` alone
    // is the correct liveness signal, and `_ending`/`_ended` for the gap
    // between a handle this adapter is already closing and one postgres or
    // the network killed. `handlesMidTeardown` closes a third gap — a
    // handle still alive but whose `stream()` cleanup hasn't finished
    // issuing its own queries yet — see that `Map`'s comment above.
    validate(handle: unknown): boolean {
      const client = handle as unknown as PgClientInternals
      return client._queryable && !client._ending && !client._ended && !handlesMidTeardown.has(handle as PgClientShim)
    },

    // A `COMMIT` against a connection whose transaction postgres has already
    // aborted (e.g. an earlier statement's error was caught and swallowed
    // inside a `db.transaction()` callback) does not error — postgres
    // silently executes it as a `ROLLBACK` instead. knex routes every
    // caller-triggered `COMMIT` through this method (`stream()`'s own
    // best-effort `COMMIT` does not, so this check has nothing to do
    // there); turns the silent loss into a typed error, without recovering
    // the work.
    //
    // Raising it here is necessary but was not sufficient: knex used to swallow
    // this error on its way back out whenever the caller committed the
    // transaction itself (`const trx = await db.transaction()` … `await
    // trx.commit()`), which resolved as though the write had landed. Getting
    // that far is `surfaceFailedCommit` in src/core/client.ts — see its comment.
    // Nothing to change on this side; the note is here because this is where
    // anyone auditing the guarantee looks first.
    async execute(handle, sql, bindings): Promise<RawResult> {
      const client = handle as PgClientShim
      const res = await client.query(sql, bindings)
      const result = toRawResult(res)
      if (isCommitStatement(sql) && result.command === 'ROLLBACK') {
        throw CfKnexError.commitSilentlyRolledBack(
          "the transaction's own work may be partially or entirely lost — an earlier statement on this connection failed and its error was caught instead of propagating, leaving the transaction aborted; find and fix that statement. Nothing can recover the work at this point: postgres rejects every statement on an aborted transaction with 25P02, including a retry. To let a statement fail without destroying the transaction, run it inside a nested transaction (`await trx.transaction(async sp => …)`), which postgres can roll back to.",
        )
      }
      return result
    },

    // Row-by-row streaming for `db(table).stream()`, over a real
    // server-side cursor (`DECLARE … CURSOR FOR` / `FETCH` / `CLOSE`)
    // rather than buffering the whole result. src/core/client.ts's
    // `_stream()` drives this generator with its own `for await`, writing
    // each yielded row into knex's output stream and awaiting backpressure.
    //
    // Cursors only exist inside a transaction, and a plain `db(t).stream()`
    // hands this method a fresh, idle connection while `db.transaction(trx
    // => trx(t).stream())` hands it one already mid-transaction. Issuing
    // `BEGIN` unconditionally is dangerous, not just redundant: postgres
    // doesn't reject a nested `BEGIN` (only a NOTICE, confirmed live), so
    // this method's own teardown would then `COMMIT` a transaction it did
    // not open — confirmed live, an outer uncommitted insert became
    // visible to a second connection the moment this method's nested
    // `COMMIT` ran.
    //
    // Detecting "already in a transaction" must work on every pg version
    // this package supports (`>=8.11.0`) and not be racy itself.
    // `Client.prototype.getTransactionStatus()` fails both: absent before
    // pg 8.21.0, and even where present it can read stale,
    // one-message-behind state right after an awaited query's promise has
    // rejected — reproduced directly, returning "T" on one run and "E" on
    // another for the identical path right after a caught `DECLARE`
    // failure. This method instead attempts `SAVEPOINT <marker>` with
    // nothing before it: success means a transaction is already open,
    // failure with SQLSTATE 25P01 means it isn't (confirmed live) — a
    // stable error code, not locale-sensitive NOTICE text. Only the
    // not-already-in-a-transaction branch issues `BEGIN`.
    //
    // The `finally` block does not run the same calls regardless of
    // outcome: an unconditional `CLOSE` then `COMMIT` on every outcome
    // masks the real error on failure — confirmed live, once
    // `DECLARE`/`FETCH` fails the transaction enters postgres's aborted
    // state and an unguarded `CLOSE` after that fails too (SQLSTATE
    // 25P02), replacing the useful original error with a generic one.
    // Failure-path cleanup is therefore best-effort, so a secondary
    // failure can never replace the original rejection.
    //
    // `RELEASE SAVEPOINT` is never issued: doing so on success would let
    // two overlapping `stream()` calls on one connection (each gets its
    // own numbered savepoint via `cursorSeq`, but they nest) corrupt each
    // other — confirmed live, releasing the outer savepoint while the
    // inner is still open implicitly releases the inner too (postgres's
    // cascading semantics), so the inner stream's later `RELEASE
    // SAVEPOINT` fails (SQLSTATE 3B001) and aborts the whole shared
    // transaction. Never releasing sidesteps this: postgres reclaims every
    // savepoint the moment the outer `COMMIT`/`ROLLBACK` runs.
    //
    // `ROLLBACK TO SAVEPOINT` on the failure path stays, unlike `RELEASE`:
    // it's what undoes postgres's aborted-transaction state after a failed
    // `DECLARE`/`FETCH`. It is not a complete fix for one sibling failing
    // while another is open on the same connection — a known, unfixed
    // limitation: savepoints are a single linear stack by creation time,
    // not a tree per `stream()` call, so rolling back to an earlier
    // savepoint destroys a still-open sibling's cursor too — reproduced
    // live: sibling B's savepoint predates A's cursor, B fails and rolls
    // back, A's next `FETCH` fails (SQLSTATE 34000), and a caller's
    // eventual `COMMIT` silently executes as a `ROLLBACK` instead — turned
    // into a thrown error by `execute()` above, but the lost work isn't
    // recovered. Gating the rollback on "no sibling open" was rejected: the
    // connection is already transaction-wide aborted the instant any
    // concurrent statement fails, so skipping it only trades one failure
    // mode for a worse one. Overlapping, unawaited streams on one
    // connection are safe only when all of them succeed.
    //
    // The three-way branch below (`failed` / `completed` / neither) is
    // what early exit needs: it reaches this `finally` through the ordinary
    // `for-await-of` teardown path, indistinguishable from the `for (;;)`
    // loop's own `break` except that `completed` is only set on that
    // natural fallthrough — so `!failed && !completed` is exactly "a
    // consumer walked away", not a failure (fetched-so-far work should
    // still land) but also not a normal finish (nothing downstream is
    // listening, and tarn may legitimately be racing to evict this handle
    // via `handlesMidTeardown`). Early-exit cleanup is therefore
    // best-effort like the failure path.
    //
    // Bind params inside `DECLARE … CURSOR FOR <select>`: confirmed live to
    // resolve correctly, since postgres parses and plans the wrapped
    // statement the same way with or without the cursor declaration.
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
            // Early exit — see the comment above the method for why this is
            // best-effort despite being the same "everything worked" outcome
            // the `completed` branch commits unguarded.
            if (!nested) await client.query('COMMIT').catch(() => {})
          }
        }
      } finally {
        unmarkMidTeardown(client)
      }
    },

    async destroy(): Promise<void> {
      // Ends whatever this adapter created that tarn never released — see
      // the `open` comment above. Clearing the set, not latching a
      // "destroyed" boolean, keeps `acquire()` free to open new connections
      // afterward — same reasoning as src/adapters/mysql2.ts's `destroy()`.
      await Promise.all([...open].map((client) => client.end()))
      open.clear()
      // Same backstop as `release()` above, for handles ended here directly.
      handlesMidTeardown.clear()
    },
  }
}

/**
 * Guards the boundary where this adapter hands a driver-shaped result back
 * to `toKnexResponse` (src/core/response.ts). Confirmed empirically against
 * a live postgres (`docker compose`'s `postgres:16` service), not assumed
 * from pg's docs:
 *
 * - `insert into t (name) values ($1)` with no `.returning()`: `{ command:
 *   'INSERT', rowCount: 1, rows: [] }` — not iterable, not an array; this is
 *   the shape that made `const [id] = await db(table).insert(...)` throw a
 *   `TypeError` before test/support/conformance.ts's postgres branch was
 *   written to ask for `.returning('id')` instead.
 * - `create table` / `drop table`: `{ command: 'CREATE' | 'DROP', rowCount:
 *   null, rows: [], fields: [] }` — `rowCount` is `null` (not `0`, not
 *   omitted).
 * - `update` / `delete`: `{ command: 'UPDATE' | 'DELETE', rowCount: <n>,
 *   rows: [] }`.
 *
 * A well-formed `Result` therefore always carries a `rows` array and a
 * `command` string (`toKnexResponse`'s postgres branch itself throws on a
 * falsy `command`, so a missing one fails loudly instead of silently
 * misreporting a DELETE/UPDATE row count as `[]`). Guarding both here, one
 * layer earlier, catches the same failure at its actual source — pg handing
 * back something that isn't a `Result` at all — with a message naming what
 * this adapter saw. `rowCount` is `number | null` on a real `Result`;
 * mapping `null` to `undefined` keeps `RawResult.affectedRows`'s contract
 * (`number`, optional, never `null`) uniform across all four adapters.
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

// `COMMIT`/`END` (postgres synonyms) with an optional `AND CHAIN`, and
// nothing else — anchored, not a prefix test, so a user query or table
// merely containing "commit" can't match. knex itself only ever sends
// plain `COMMIT;`; `END`/`AND CHAIN` are only reachable via a caller's own
// `raw()`, but return the identical silent-`ROLLBACK` shape when aborted,
// confirmed live, so they're covered too.
const COMMIT_STATEMENT = /^(?:COMMIT|END)(?:\s+AND\s+CHAIN)?\s*;?\s*$/i

function isCommitStatement(sql: string): boolean {
  return COMMIT_STATEMENT.test(sql)
}
