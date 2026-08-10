import type { Knex as KnexType } from 'knex'
// The knex factory (`import Knex from 'knex'`) statically reaches `knex/lib/dialects/index.js`,
// which a bundler must follow even though that branch never runs here (see knex-dialects.d.ts).
// `makeKnex` builds a callable `knex()` from an already-constructed client, bypassing that path.
import makeKnex from 'knex/lib/knex-builder/make-knex.js'
// knex ships no types for these deep CJS dialect paths (see ./knex-dialects.d.ts). Trailing
// `/index.js` is required: knex has no `exports` map, so plain Node ESM would otherwise throw
// `ERR_UNSUPPORTED_DIR_IMPORT` (require() and bundlers resolve it fine either way).
import Client_MySQL2 from 'knex/lib/dialects/mysql2/index.js'
import Client_PG from 'knex/lib/dialects/postgres/index.js'
import Client_SQLite3 from 'knex/lib/dialects/sqlite3/index.js'
import type { DisposableKnex } from './disposable'
import { CfKnexError } from './errors'
import { toKnexResponse } from './response'
import type { Dialect, DriverAdapter } from './types'

/**
 * Subset of Node's `Writable` interface `_stream()` needs. knex's own `Runner.stream()`
 * (execution/runner.js) always passes a real `Transform` here, but this project has no
 * `@types/node` dependency (see test/process.d.ts), so only the members actually used are
 * declared — same shim pattern as src/adapters/mysql2.ts's `Mysql2ConnectionShim`.
 */
type StreamSink = {
  readonly destroyed: boolean
  write(chunk: unknown): boolean
  end(): void
  emit(event: 'error', err: unknown): boolean
  once(event: 'drain', listener: () => void): void
  once(event: 'close', listener: () => void): void
  once(event: 'error', listener: (err: unknown) => void): void
  off(event: 'drain', listener: () => void): void
  off(event: 'close', listener: () => void): void
  off(event: 'error', listener: (err: unknown) => void): void
}

/**
 * Thrown internally by `waitForDrain`, never surfaced to a caller: when a
 * `for await` consumer stops early, Node destroys the readable side without
 * ever emitting another 'drain' — only 'close' (and sometimes 'error') —
 * verified empirically. A write loop that only waited on 'drain' would hang
 * forever once backpressure and an early exit coincide. A distinct type
 * (not a plain rejection) lets the catch block below tell "consumer walked
 * away" apart from a real failure.
 */
class StreamSinkClosed extends Error {}

/**
 * `true` for the error Node's `Readable` async-iterator protocol raises
 * when a `for await` consumer stops early: `.return()` destroys the stream
 * and emits this — `name: 'AbortError'`, `code: 'ABORT_ERR'` — *before*
 * 'close', confirmed empirically. Same intent as `StreamSinkClosed` ("the
 * reader walked away," not a write failure), so `waitForDrain`'s `onError`
 * treats it the same way instead of rejecting.
 */
function isSinkAbortedByReader(err: unknown): boolean {
  return err instanceof Error && (err as { code?: unknown }).code === 'ABORT_ERR' && err.name === 'AbortError'
}

/**
 * Resolves once `stream` emits 'drain', or rejects once no 'drain' is
 * coming (see `StreamSinkClosed`). `stream.destroyed` is checked up front
 * because a stream already destroyed won't emit a fresh 'close' for a
 * listener attached after the fact, and `EventEmitter` never replays past events.
 */
function waitForDrain(stream: StreamSink): Promise<void> {
  if (stream.destroyed) return Promise.reject(new StreamSinkClosed())
  return new Promise<void>((resolve, reject) => {
    const onDrain = () => {
      stream.off('error', onError)
      stream.off('close', onClose)
      resolve()
    }
    const onError = (err: unknown) => {
      stream.off('drain', onDrain)
      stream.off('close', onClose)
      // Per `isSinkAbortedByReader` above: this is the consumer walking
      // away (always arrives as 'error', before 'close'), not a genuine
      // write failure — `_stream()`'s catch only swallows `StreamSinkClosed`.
      reject(isSinkAbortedByReader(err) ? new StreamSinkClosed() : err)
    }
    const onClose = () => {
      stream.off('drain', onDrain)
      stream.off('error', onError)
      reject(new StreamSinkClosed())
    }
    stream.once('drain', onDrain)
    stream.once('error', onError)
    stream.once('close', onClose)
  })
}

// Static imports (not `createRequire`) so the bundler can follow these
// paths and a resolution failure surfaces at import time.
//
// Known limitation: each dialect class builds its own `Logger`, whose
// `colorette` dependency fails to resolve under vitest-pool-workers, so any
// `logger.warn/error/deprecate` call inside a dialect constructor throws.
// Not fixable from here; `initializeDriver()` and the sqlite defaults below
// avoid that path.
const DIALECT_CLASSES: Record<Dialect, unknown> = {
  mysql: Client_MySQL2,
  postgres: Client_PG,
  sqlite: Client_SQLite3,
}

function loadDialect(dialect: Dialect): new (...args: never[]) => unknown {
  const Base = DIALECT_CLASSES[dialect]
  // Runtime guard for a future knex version that keeps this path resolvable
  // but changes what it exports (e.g. a named export instead of default).
  if (typeof Base !== 'function') {
    throw new CfKnexError('INCOMPATIBLE_KNEX', `'knex/lib/dialects' entry for '${dialect}' did not export a constructor`)
  }
  return Base as new (...args: never[]) => unknown
}

const DEFAULT_LOG = {
  // Plain console: no TTY here, and colorette isn't reliable in this harness (see above).
  warn: (message: string) => console.warn(message),
  error: (message: string) => console.error(message),
  deprecate: (message: string) => console.warn(message),
}

/**
 * How long `destroy()` may take in total before giving up and returning anyway.
 * This only ever elapses on a path that is already broken — see `destroy()`
 * below for what "broken" means here.
 *
 * Total, not per phase: teardown waits on the pool and then on the adapter, and
 * a caller sizing this against a request budget cares what `destroy()` costs
 * them end to end, not how it is divided internally. `runTeardown` gives the
 * adapter whatever the pool left.
 *
 * Deliberately *above* tarn's `destroyTimeoutMillis` (5000, its default and
 * ours). tarn already bounds each individual handle close at that value and
 * reports the failure itself; a smaller budget here would fire first and blame
 * the caller for something tarn was one moment away from handling cleanly.
 */
const DESTROY_TIMEOUT_MS = 6_000

/**
 * The in-flight (or finished) teardown for a client, so a second `destroy()`
 * awaits the first one's outcome instead of running the whole thing again.
 *
 * Without this, `destroy()` is not idempotent: knex's base `Client.destroy()`
 * no-ops on the second call (it has already cleared `this.pool`), but
 * `adapter.destroy()` would run a second time and tear down connections a
 * still-live caller re-opened in between. Keyed weakly so a discarded client
 * is still collectable.
 */
const teardowns = new WeakMap<object, Promise<void>>()

type TeardownOutcome = { state: 'ok' } | { state: 'failed'; error: unknown } | { state: 'timed-out' }

/**
 * Awaits `work`, or gives up after `ms`. Never rejects — a rejection is
 * reported as `{ state: 'failed' }` so the caller decides when (and whether)
 * to surface it, rather than having it abort the rest of teardown.
 *
 * The timer is cleared on every path. A `setTimeout` left armed would hold a
 * Worker's I/O context open for the remainder of the budget after teardown had
 * already finished, which is the opposite of what this function is for.
 */
async function settleWithin(work: Promise<unknown>, ms: number): Promise<TeardownOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work.then(
        (): TeardownOutcome => ({ state: 'ok' }),
        (error: unknown): TeardownOutcome => ({ state: 'failed', error }),
      ),
      new Promise<TeardownOutcome>((resolve) => {
        timer = setTimeout(() => resolve({ state: 'timed-out' }), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

// Says only what actually happened. Nothing is force-closed on this path: the
// pool keeps draining in the background, and claiming otherwise would send
// someone looking for a leak in the wrong place.
const poolTimedOutMessage = (ms: number): string =>
  `cf-knex: destroy() stopped waiting for the connection pool after ${ms}ms and returned. Nothing was force-closed — the pool is still draining. ` +
  'A connection was still checked out, which almost always means a transaction from `const trx = await db.transaction()` was never committed or rolled back. ' +
  'On TiDB Cloud Serverless and Turso the locks it holds stay held server-side until the backend expires them. ' +
  'Use `await using trx = await db.transaction()`, or the callback form `db.transaction(async trx => { … })`, which releases on every path including a throw.'

const adapterTimedOutMessage = (driver: string, ms: number): string =>
  `cf-knex: the ${driver} adapter's own teardown did not finish within the ${ms}ms left of the destroy() budget; destroy() returned anyway. Connections it still held may not be closed yet.`

/**
 * The body of `destroy()`, minus the transactor guard and the callback
 * plumbing. Split out so the promise it returns can be memoised in `teardowns`
 * before anything awaits it.
 *
 * Both halves are bounded, and `adapter.destroy()` runs even when the pool
 * teardown failed or timed out — it is the adapter's own backstop for handles
 * the pool never got to, so skipping it is exactly wrong on the path where it
 * matters most. Errors from either half are re-thrown only once both have had
 * their turn.
 */
async function runTeardown(
  poolTeardown: Promise<void>,
  adapter: DriverAdapter,
  budgetMs: number,
  warn: (message: string) => void,
): Promise<void> {
  const startedAt = Date.now()
  const pool = await settleWithin(poolTeardown, budgetMs)
  if (pool.state === 'timed-out') warn(poolTimedOutMessage(budgetMs))

  // `budgetMs` is what `destroy()` costs the caller in total, so the adapter
  // gets what the pool left rather than a second full budget of its own.
  // `adapter.destroy()` is still *started* when that remainder is zero: it is
  // the adapter's backstop for handles the pool never released, so skipping it
  // is exactly wrong on the path where it matters most. Only the waiting is
  // given up, never the call.
  const remainingMs = Math.max(0, budgetMs - (Date.now() - startedAt))
  const teardown = await settleWithin(adapter.destroy(), remainingMs)
  if (teardown.state === 'timed-out') warn(adapterTimedOutMessage(adapter.driver, remainingMs))

  if (pool.state === 'failed') throw pool.error
  if (teardown.state === 'failed') throw teardown.error
}

/**
 * Adds `Symbol.asyncDispose` to `target` if it isn't already there, so
 * `await using` manages it. Guarded on the symbol existing at all: this package
 * supports runtimes older than explicit resource management, where the
 * property would otherwise be keyed by `undefined`.
 *
 * Non-enumerable to match how `makeKnex` defines everything else on a knex
 * object, so `Object.assign`-style clones (`withUserParams`) and anything that
 * walks own keys behave exactly as they did before.
 */
/**
 * Rolls a transactor back if the caller never finished it, so
 * `await using trx = await db.transaction()` cannot strand a transaction the
 * way an abandoned bare transactor does. A committed or already-rolled-back
 * transaction disposes to a no-op.
 *
 * `rollback()` is called with no argument deliberately. knex defaults
 * `doNotRejectOnRollback` to `true` for `db.transaction(…)`
 * (knex/lib/knex-builder/make-knex.js), and on that setting an argument-less
 * ROLLBACK *resolves* the transaction's execution promise rather than rejecting
 * it (knex/lib/execution/transaction.js). Passing an error here would reject a
 * promise that, in the transactor form, nothing is left awaiting — turning an
 * ordinary scope exit into an unhandled rejection.
 *
 * Not bounded here because knex already bounds it: its `Transaction.rollback()`
 * wraps the ROLLBACK query in a 5000 ms `timeout(…)` and settles even when that
 * expires. A second timer would only pre-empt knex's own reporting.
 */
async function disposeTransactor(transactor: object): Promise<void> {
  const trx = transactor as {
    isCompleted?: () => boolean
    rollback?: (error?: unknown) => Promise<unknown>
  }
  if (typeof trx.isCompleted === 'function' && trx.isCompleted()) return
  if (typeof trx.rollback !== 'function') return
  await trx.rollback()
}

/**
 * Makes `await trx.commit()` reject when the COMMIT actually failed.
 *
 * knex swallows that failure. `Transaction.query()`
 * (knex/lib/execution/transaction.js) catches whatever the COMMIT statement
 * threw, assigns it to the transaction's own promise through `_rejecter`, and
 * resolves the promise it handed `commit()` anyway. In the callback form that
 * costs nothing — `db.transaction(cb)` *is* that promise, so the caller still
 * sees the error. In the transactor form it loses it outright:
 * `_transaction()` (knex/lib/knex-builder/make-knex.js) wires the promise to a
 * `reject` belonging to a promise it has already resolved with the transactor,
 * so nothing is listening, and `await trx.commit()` resolves as though the
 * work had landed.
 *
 * That is silent data loss rather than a reporting nicety. The case it was
 * found through is postgres executing a COMMIT as a ROLLBACK, which
 * src/adapters/pg.ts raises `COMMIT_SILENTLY_ROLLED_BACK` for — an error whose
 * entire purpose is to say the work is gone, and which never reached the
 * caller on this path. Nothing about it is postgres-specific: a connection
 * dropped mid-COMMIT is discarded the same way, on every adapter.
 *
 * Applied only to the transactor form, decided by the same signal knex itself
 * uses — a container whose return value is not thenable is one knex will not
 * chain `commit`/`rollback` onto (`_onAcquire`, transaction.js). The callback
 * form is left alone: it already propagates, and rejecting its `commit()` here
 * would divert it into knex's own `.catch(err => transactor.rollback(err))`,
 * issuing a ROLLBACK against a transaction that is already finished.
 *
 * The execution promise is observed with a handler that converts a rejection
 * into a value rather than by consuming it, so this neither swallows the error
 * from anyone else awaiting it nor leaves it unhandled when the caller
 * abandons the transaction instead of committing. `undefined` is the sentinel
 * for "settled cleanly"; knex guarantees a non-`undefined` rejection reason,
 * substituting an Error of its own when a caller rejects with nothing.
 */
// Deliberately the same duck-test knex's own `_onAcquire` applies to a
// container's return value (`result && result.then && typeof result.then ===
// 'function'`), not `instanceof Promise`: matching it exactly is what keeps
// "knex will chain commit/rollback onto this" and "cf-knex leaves commit alone"
// the same predicate.
function isThenable(value: unknown): boolean {
  return typeof (value as { then?: unknown } | null | undefined)?.then === 'function'
}

function surfaceFailedCommit(transactor: object): void {
  const trx = transactor as {
    commit?: (value?: unknown) => Promise<unknown>
    executionPromise?: Promise<unknown>
  }
  const commit = trx.commit
  const executionPromise = trx.executionPromise
  if (typeof commit !== 'function' || typeof executionPromise?.then !== 'function') return

  const outcome = Promise.resolve(executionPromise).then(
    () => undefined,
    (err: unknown) => err,
  )

  trx.commit = async (value?: unknown) => {
    const result = await commit.call(transactor, value)
    // Safe to await: `commit()` routes through `Transaction.query(…, 1, …)`,
    // which settles the execution promise via `_resolver`/`_rejecter` before
    // the promise awaited above resolves, so this is already decided.
    const failure = await outcome
    if (failure !== undefined) throw failure
    return result
  }
}

function defineAsyncDispose(target: object, dispose: () => Promise<void>): void {
  if (typeof Symbol.asyncDispose !== 'symbol') return
  if (Symbol.asyncDispose in target) return
  Object.defineProperty(target, Symbol.asyncDispose, {
    configurable: true,
    writable: true,
    enumerable: false,
    value: dispose,
  })
}

// `loadDialect` types the base instance as `unknown` since nothing else
// here calls an inherited member by name. `destroy()`, `transaction()` and
// `prepBindings()` below are exceptions — each calls `super.*()` — so those
// three are typed explicitly; everything else stays `unknown`.
type KnexClientInstance = Record<string, unknown> & {
  destroy(callback?: (err?: unknown) => void): Promise<void>
  transaction(container: unknown, config?: unknown, outerTx?: unknown): unknown
  prepBindings(bindings: unknown[]): unknown[]
}

const MIGRATION_ACCESSORS = [
  ['migrate', 'db.migrate'],
  ['seed', 'db.seed'],
] as const

// The real cause (see `hardenMigrationAccessors` below) is knex's own
// `browser` field substitution, which wrangler/esbuild honour regardless of
// migration/seed source — not "no filesystem" (a caller-supplied
// `migrationSource`/`seedSource` never touches disk, yet still throws), and
// not any one driver (the substitution happens at bundle time, before a
// driver is chosen, so it hits all five identically).
const MIGRATION_UNAVAILABLE_HINT =
  "Knex.js's own package.json 'browser' field maps Migrator/Seeder to a no-op, and real wrangler/esbuild honours that field when bundling for Workers, so this getter cannot construct a real one here. Run migrations/seeds from your own tooling against the database directly instead: `wrangler d1 migrations` for D1, the Turso/libsql CLI, or a plain Node Knex.js process against Postgres/MySQL — never from inside the Worker."

/**
 * Redefines `migrate`/`seed` on `target` so a `TypeError` escaping the original getter
 * comes back as a `CfKnexError` (`UNSUPPORTED_CAPABILITY`) naming the capability, instead
 * of an unattributable `TypeError: Migrator is not a constructor`. The original getter
 * runs first, so where it resolves to a real class (Node, and this project's own `workers`
 * vitest pool), `db.migrate`/`db.seed` still work. Mutates `target` in place.
 *
 * Exported for its own unit tests, which drive it against a plain object:
 * `@cloudflare/vitest-pool-workers` doesn't honour knex's `browser` field the way real
 * wrangler/esbuild does, so the throwing getter it causes can't be reproduced from a test
 * in this repo.
 */
export function hardenMigrationAccessors(target: object): void {
  for (const [prop, capability] of MIGRATION_ACCESSORS) {
    const descriptor = Object.getOwnPropertyDescriptor(target, prop)
    if (!descriptor || typeof descriptor.get !== 'function') continue
    const originalGet = descriptor.get
    Object.defineProperty(target, prop, {
      configurable: true,
      enumerable: descriptor.enumerable,
      get(): unknown {
        try {
          return originalGet.call(this)
        } catch (err) {
          if (!(err instanceof TypeError)) throw err
          throw new CfKnexError('UNSUPPORTED_CAPABILITY', `${capability} is not available inside a Worker. ${MIGRATION_UNAVAILABLE_HINT}`)
        }
      },
    })
  }
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- mirrors knex's own public `Knex<TRecord, TResult>` signature (node_modules/knex/types/index.d.ts); widening it would diverge from knex's generics and break `.select()`/`.selec()` type-checking.
export function createKnexClient<TRecord extends {} = any, TResult = unknown[]>(
  adapter: DriverAdapter,
  knexOptions: Record<string, unknown> = {},
): DisposableKnex<TRecord, TResult> {
  // Pulled out before anything else so it never reaches knex's own config, which
  // has no such option and would carry it into every `Client` that clones config.
  const { destroyTimeoutMs, ...clientOptions } = knexOptions as Record<string, unknown> & {
    destroyTimeoutMs?: number
  }
  const destroyBudgetMs =
    typeof destroyTimeoutMs === 'number' && Number.isFinite(destroyTimeoutMs) && destroyTimeoutMs > 0
      ? destroyTimeoutMs
      : DESTROY_TIMEOUT_MS

  // `config: Record<string, unknown>` (not `loadDialect`'s own `never[]`)
  // since `resolvedConfig` below is passed straight into `new CfKnexClient(...)`.
  const Base = loadDialect(adapter.dialect) as new (config: Record<string, unknown>) => KnexClientInstance

  class CfKnexClient extends Base {
    // Each dialect's base implementation `require()`s the real native driver package
    // (mysql2/pg/sqlite3) — unavailable in workerd and unnecessary, since `adapter` supplies
    // connections instead. Nothing below reads `this.driver`, so no-opping this is safe.
    initializeDriver() {}

    // Deliberately NOT overriding `acquireConnection`/`releaseConnection`: the base `Client`
    // implementation calls `this.pool.acquire()`/`release()`, what makes tarn's pool real.
    // Overriding them directly instead — tried first — bypasses tarn entirely, so the pool
    // never tracks or reaps a handle (see `DriverAdapter`'s doc comment in ./types.ts). The
    // hooks below let tarn own pooling and call `adapter` only when it creates/evicts a handle.

    async acquireRawConnection() {
      return adapter.acquire()
    }

    async destroyRawConnection(handle: unknown) {
      await adapter.release(handle)
    }

    // knex's stock mysql2 dialect checks fields specific to a live mysql2 socket
    // (`connection._fatalError`, `.stream.destroyed`, etc). Those don't exist on every
    // handle `adapter` may hand back (e.g. tidb-http/d1/libsql), so reading them would
    // throw and tarn would discard a valid connection on every acquire. Delegate to
    // `DriverAdapter.validate` (src/core/types.ts) when implemented — needed for handles
    // that can go stale between queries, e.g. mysql2's TCP connection — default to
    // always valid otherwise.
    validateConnection(handle: unknown): boolean {
      return adapter.validate ? adapter.validate(handle) : true
    }

    // knex's own hook (base `Client`), not `_query()` below: converting there would miss
    // `client.stream()`, which reaches `enrichQueryObject()` (and thus `prepBindings`) then
    // `_stream()`, never `_query()` — relevant once a sqlite-family adapter declares
    // `capabilities.streaming`. It also runs before the `query` event and before a failed
    // query's SQL is interpolated into its error, so both see the values actually sent.
    //
    // sqlite-only, `Date`/boolean only: the base `prepBindings` is a plain passthrough, and
    // knex's sqlite3 dialect never overrides it — only `Client_BetterSQLite3._formatBindings`
    // converts these two types, the same way below, letting a knex + better-sqlite3 codebase
    // migrate to any sqlite-family adapter here without its stored values changing shape.
    // mysql2/pg accept `Date`/boolean natively — converting would corrupt timestamp columns —
    // so every other dialect falls through.
    prepBindings(bindings: unknown[]): unknown[] {
      if (adapter.dialect !== 'sqlite') return super.prepBindings(bindings)
      // Carried over from `_formatBindings`. No path this project exercises reaches here
      // with a non-array — verified by throwing on non-array and running the suite green.
      if (!bindings) return []
      return bindings.map((binding) => {
        if (binding instanceof Date) return binding.valueOf()
        if (typeof binding === 'boolean') return Number(binding)
        return binding
      })
    }

    async _query(handle: unknown, obj: Record<string, unknown>) {
      const raw = await adapter.execute(handle, obj.sql as string, (obj.bindings as unknown[]) ?? [])
      return toKnexResponse(adapter.dialect, raw, obj)
    }

    // `capabilities.streaming` alone is a claim; `adapter.stream` existing is the proof —
    // gating on both stops a future adapter that sets the flag without implementing the
    // method from crashing on "not a function" instead of failing with this file's typed
    // error (same reasoning as `validateConnection`'s `adapter.validate` check above).
    //
    // Must return a Promise that genuinely settles on the stream's outcome (resolves on
    // completion, rejects on error, emits on the stream in the error case too), matching
    // knex's own postgres `_stream` contract — otherwise a caller `await`-ing `.stream()`'s
    // promise could see success on a stream that actually failed.
    //
    // That settling doesn't fully control how long the connection stays held: knex has two
    // independent release paths. Outside a transaction, `Runner.ensureConnection`'s `finally`
    // awaits this method, but `Runner.stream()` also releases on the output Transform's
    // 'close' event at creation time, firing the instant a consumer breaks early, independent
    // of this method's promise. Inside a transaction, query builders run against `trxClient`,
    // whose `releaseConnection` is a no-op (`makeTxClient`), so that same 'close' handler
    // touches nothing — the real release happens in
    // `Transaction.prototype.acquireConnection`'s `finally` instead, regardless of any
    // unawaited `stream()` still mid-cleanup on that transaction. An adapter whose `stream()`
    // cleanup can issue queries after an early exit (src/adapters/pg.ts's cursor teardown)
    // must defend against both races, since both ultimately call `releaseConnection`; see
    // pg.ts's `handlesMidTeardown` comment.
    _stream(handle: unknown, obj: Record<string, unknown>, stream: StreamSink): Promise<void> {
      if (!adapter.capabilities.streaming || !adapter.stream) {
        throw CfKnexError.unsupported(adapter.driver, 'streaming', adapter.hints?.streaming ?? 'Use .limit()/.offset() to paginate.')
      }
      // Both stock dialects this replaces guard identically: postgres's and mysql2's
      // `_stream` (node_modules/knex/lib/dialects/{postgres,mysql}/index.js) throw
      // synchronously on `!obj.sql`, not reject. knex's own `ensureConnectionStreamCallback`
      // wraps this call in a try/catch that turns a synchronous throw into
      // `stream.emit('error', …)` plus a rejection — matching that shape keeps this inside
      // that already-handled path.
      if (!obj.sql) throw new Error('The query is empty')

      const rows = adapter.stream(handle, obj.sql as string, (obj.bindings as unknown[]) ?? [])
      return (async () => {
        try {
          for await (const row of rows) {
            // A `false` return means the sink's buffer is full — writing the next row
            // anyway (the original draft did) buffers the whole result set in memory once
            // the consumer falls behind, defeating streaming. `waitForDrain` also resolves
            // the sink-closes-instead-of-drains race, so this can't hang on a departed consumer.
            if (!stream.write(row)) await waitForDrain(stream)
          }
          stream.end()
        } catch (err) {
          if (err instanceof StreamSinkClosed) return
          stream.emit('error', err)
          throw err
        }
      })()
    }

    // knex's base `Client.transaction()` has no notion of `adapter.capabilities` and will
    // happily issue BEGIN/COMMIT/ROLLBACK as ordinary queries even when the adapter can't
    // guarantee they land on the same session (`capabilities.transactions: false`) — writes
    // appear to succeed and a rollback silently commits. Gate it here, same as `_stream()`
    // gates streaming above.
    //
    // Must return a *rejected Promise*, not throw synchronously: make-knex.js's
    // `_transaction()` returns this method's result unwrapped for the common
    // `db.transaction(async trx => {...})` shape — a synchronous throw would escape as an
    // exception instead of the rejected promise callers `await`/`.catch()` expect.
    transaction(container: unknown, config?: unknown, outerTx?: unknown): unknown {
      if (!adapter.capabilities.transactions) {
        return Promise.reject(
          CfKnexError.unsupported(
            adapter.driver,
            'transactions',
            adapter.hints?.transactions ??
              'Each query executes as an independent request against this driver, so BEGIN/COMMIT/ROLLBACK cannot be guaranteed to share a session.',
          ),
        )
      }
      // The disposer goes on via the *container*, not by unwrapping the return
      // value, because that is the one place both call shapes meet. knex's
      // `_transaction()` (knex-builder/make-knex.js) turns the no-container form
      // `const trx = await db.transaction()` into a container of its own — it
      // passes `resolve` — so wrapping here covers `db.transaction(async trx =>
      // …)`, the transactor form, and nested savepoints identically, with
      // nothing to special-case.
      //
      // `surfaceFailedCommit` hangs off the container's *return value* for the
      // reason spelled out on the helper: only a non-thenable return marks the
      // transactor form, the one shape where knex loses a failed COMMIT. That
      // return value is available here and nowhere else.
      const wrapped =
        typeof container === 'function'
          ? (transactor: object) => {
              defineAsyncDispose(transactor, () => disposeTransactor(transactor))
              const result = (container as (t: object) => unknown)(transactor)
              if (!isThenable(result)) surfaceFailedCommit(transactor)
              return result
            }
          : container
      return super.transaction(wrapped, config, outerTx)
    }

    // Base `Client.destroy()` only tears down the pool (which, via the tarn hooks above,
    // calls `destroyRawConnection`/`adapter.release()` per handle) — it has no notion of
    // `adapter` itself, so without this override `adapter.destroy()` and state outliving
    // individual handles (e.g. src/adapters/mysql2.ts's bookkeeping) would go untorn-down.
    // `super.destroy()` runs the base teardown first, then `adapter.destroy()`.
    //
    // `this` isn't always the real client: knex's transaction machinery (`makeTxClient`)
    // builds a *transactor* sharing this prototype, marked `transacting: true` — so
    // `trx.destroy()` reaches this method too. `super.destroy()` already no-ops for it
    // (no pool of its own), but without the guard below `adapter.destroy()` would still
    // tear down every connection the adapter holds, including the one COMMIT is still using.
    //
    // Bounded, and memoised. tarn waits on its `used` list with a bare `Promise.all` over
    // each resource's deferred and no timeout of its own (tarn/dist/Pool.js), so a single
    // connection that never comes back — an abandoned `const trx = await db.transaction()`,
    // or a query whose caller stopped awaiting — used to wedge this method forever. It now
    // gives up after `destroyTimeoutMs` and says so.
    //
    // Giving up is not the same as fixing it, and this deliberately does not pretend
    // otherwise: nothing is force-closed. Prising a handle out of tarn mid-transaction was
    // tried and abandoned — the release path has to run through the adapter, and on
    // tidb-http a `BEGIN` already on the wire has no `Tx` to roll back yet, so the forced
    // pass would report success while TiDB still held the lock. A caller who ends up here
    // has already stranded that transaction; the honest fix is to not strand it, which is
    // what the disposer on the transactor is for.
    //
    // Memoised through `teardowns` so a second call awaits the first rather than running
    // `adapter.destroy()` again.
    async destroy(callback?: (err?: unknown) => void): Promise<void> {
      if ((this as unknown as { transacting?: boolean }).transacting) {
        if (typeof callback === 'function') callback()
        return
      }

      let teardown = teardowns.get(this)
      if (!teardown) {
        // `super.destroy()` is called here, as a statement, rather than inside
        // the arrow it would be more natural to pass to `runTeardown` — lexical
        // `super` in a nested arrow inside a dynamically-extended base class is
        // more bundler surface than this needs.
        const poolTeardown = super.destroy()
        const log = (this as unknown as { config?: { log?: { warn?: unknown } } }).config?.log
        const warn = typeof log?.warn === 'function' ? (log.warn as (message: string) => void) : DEFAULT_LOG.warn
        teardown = runTeardown(poolTeardown, adapter, destroyBudgetMs, warn)
        teardowns.set(this, teardown)
      }

      try {
        await teardown
        if (typeof callback === 'function') callback()
      } catch (err) {
        if (typeof callback === 'function') return callback(err)
        throw err
      }
    }
  }

  // sqlite3's constructor warns (see above) unless `connection.filename` and
  // `useNullAsDefault` are already set. `filename` is never opened — `adapter` owns the connection.
  const dialectDefaults: Record<string, unknown> = adapter.dialect === 'sqlite' ? { useNullAsDefault: true } : {}
  // ':memory:' satisfies the check above only; knex never opens it.
  const connectionDefault: Record<string, unknown> = adapter.dialect === 'sqlite' ? { filename: ':memory:' } : {}

  // Overrides knex's inherited pool default (`min: 2, max: 10`). This library's usage
  // pattern is a fresh client per request, never a cached module-level global (Hyperdrive
  // pools server-side; reusing a cached knex object across requests throws workerd's
  // "Cannot perform I/O on behalf of a different request"). tarn only opens connections to
  // satisfy pending acquires (`_shouldCreateMoreResources`, tarn's Pool.js), so `min: 2`
  // doesn't open two eagerly — but tarn's reap arithmetic (`maxDestroy = free.length - (min
  // - used.length)`) never fires while at most `min` connections sit idle, so the one
  // connection a request opens is pinned open for that client's whole lifetime instead of
  // reclaimable — backwards for a client about to be destroyed anyway. `min: 0` removes
  // that floor; `max: 5` is a modest per-client ceiling, not a promise every
  // adapter/database can sustain concurrently.
  const poolDefault: Record<string, unknown> = { pool: { min: 0, max: 5 } }

  // `connection`/`log` must merge with their defaults, not replace them (an incomplete
  // caller `connection` would reintroduce the sqlite crash above) — handled explicitly
  // below rather than by spread order. `pool` and everything else override freely via `restOptions`.
  const { connection: callerConnection, log: callerLog, ...restOptions } = clientOptions as Record<string, unknown> & {
    connection?: Record<string, unknown>
    log?: Record<string, unknown>
  }

  // Mirrors knex's own factory (`makeKnex(new Dialect(resolvedConfig))` plus copying
  // `userParams`), minus `resolveConfig` itself — that exists only to turn a
  // `client`/`dialect` string into a class via `knex/lib/dialects`, which `CfKnexClient`
  // already is. Constructing it directly keeps that lookup, and its bundler-hostile import, out of the graph.
  const resolvedConfig = {
    ...dialectDefaults,
    ...poolDefault,
    ...restOptions,
    connection: { ...connectionDefault, ...callerConnection },
    log: { ...DEFAULT_LOG, ...callerLog },
    client: CfKnexClient as unknown as typeof KnexType.Client,
  }
  const newKnex = makeKnex(new CfKnexClient(resolvedConfig)) as DisposableKnex<TRecord, TResult>
  hardenMigrationAccessors(newKnex)
  // `destroy()` is bounded and idempotent above, which is what makes this safe to
  // attach at all: a disposer that could hang would turn every `await using` scope
  // exit into the deadlock it exists to avoid.
  defineAsyncDispose(newKnex, () => newKnex.destroy())
  const userParams = (resolvedConfig as { userParams?: unknown }).userParams
  if (userParams) (newKnex as unknown as { userParams: unknown }).userParams = userParams
  return newKnex
}
