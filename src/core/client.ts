import Knex from 'knex'
import type { Knex as KnexType } from 'knex'
// knex ships types only for its public entry point; these deep CJS dialect
// paths have no shipped declarations — see ./knex-dialects.d.ts. The
// trailing `/index.js` is required, not cosmetic: knex has no `exports` map,
// so plain Node ESM (no bundler) refuses to resolve a bare directory import
// here (`ERR_UNSUPPORTED_DIR_IMPORT`) even though `require()` and every
// bundler resolve it fine without it.
import Client_MySQL2 from 'knex/lib/dialects/mysql2/index.js'
import Client_PG from 'knex/lib/dialects/postgres/index.js'
import Client_SQLite3 from 'knex/lib/dialects/sqlite3/index.js'
import { CfKnexError } from './errors'
import { toKnexResponse } from './response'
import type { Dialect, DriverAdapter } from './types'

/**
 * The subset of Node's `Writable` interface `_stream()` below needs. knex's
 * own `Runner.stream()` (node_modules/knex/lib/execution/runner.js) always
 * builds this as a real `Transform` (`new Transform({ objectMode: true, ...
 * })`) and passes it through `Client.prototype.stream()` →
 * `_stream(connection, queryObject, stream, options)`
 * (node_modules/knex/lib/client.js), so at runtime this is always a genuine
 * Node stream. This project has no `@types/node` dependency and deliberately
 * keeps it that way (see test/process.d.ts for the same constraint applied
 * to `process`) — `src` is imported by both the `workers` and `node` vitest
 * projects (see vitest.config.ts), and this file in particular is the one
 * every adapter, including the workerd-only ones, is wired through, so
 * pulling in the full Node stream surface here would be misleading. Declare
 * only the members actually called below, the same shim-over-untyped-import
 * pattern src/adapters/mysql2.ts's `Mysql2ConnectionShim` uses.
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
 * Thrown internally by `waitForDrain` — never surfaced to a caller — when
 * the destination stream closes on its own instead of draining. Node's
 * `Readable` async-iterator protocol destroys the stream a consumer is
 * `for await`-ing as soon as that consumer stops early (a `break`, e.g.
 * `for await (const row of db(t).stream()) { if (done) break }`), and does
 * so without ever emitting 'drain' again — verified empirically (a `Transform`
 * destroyed this way emits 'close', and in that specific case also 'error',
 * but never another 'drain'). A write loop that only waited on 'drain' would
 * hang forever the moment backpressure and an early consumer exit coincide.
 * This being a distinct type (not a plain rejection) is what lets the catch
 * block below tell "the consumer walked away, stop quietly" apart from a
 * real failure that must reject `_stream()`'s own promise and be reported.
 */
class StreamSinkClosed extends Error {}

/**
 * `true` for the exact error Node's own `Readable` async-iterator protocol
 * raises on the stream it is `for await`-ing when a consumer stops early — a
 * `break` inside `for await (const row of db(t).stream())` calls `.return()`
 * on the readable side, which destroys it, which — confirmed empirically,
 * consistently, independent of whether a read was pending at the moment of
 * the `break` — emits this *before* 'close', not instead of it: `name:
 * 'AbortError'`, `code: 'ABORT_ERR'`. This is Node's own signal for "the
 * reader walked away," structurally identical in intent to `StreamSinkClosed`
 * below (both exist to tell "the consumer lost interest" apart from "the
 * write actually failed") — `waitForDrain`'s `onError` treats it exactly the
 * same way, rather than rejecting with it as if it were a genuine failure a
 * caller needs to hear about.
 */
function isSinkAbortedByReader(err: unknown): boolean {
  return err instanceof Error && (err as { code?: unknown }).code === 'ABORT_ERR' && err.name === 'AbortError'
}

/**
 * Resolves once `stream` emits 'drain', or rejects/resolves once it becomes
 * clear no 'drain' is coming — see `StreamSinkClosed` above for why both
 * outcomes exist. `stream.destroyed` is checked up front for the same reason:
 * a stream already destroyed before this is even called (the consumer left
 * between one write and the next) will not emit a fresh 'close' for a
 * listener attached after the fact, and 'close'/'drain' both being events
 * `EventEmitter` only fires forward in time, never replays past
 * ones — waiting on them unconditionally would hang exactly as long as never
 * checking `destroyed` at all.
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
      // See `isSinkAbortedByReader` above: this specific error is the
      // consumer walking away, arriving here as 'error' (always, and always
      // *before* 'close' — confirmed empirically, not just in the odd case),
      // not a genuine write failure. Rejecting with the real error here
      // would otherwise be indistinguishable, downstream, from an actual
      // failure — `_stream()`'s catch block only knows to swallow a
      // `StreamSinkClosed`.
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

// Static imports (not `createRequire`) so these paths are visible to the
// bundler and a resolution failure surfaces at import time.
//
// Known limitation: each dialect class builds its own internal `Logger`,
// and that instance's `colorette` dependency fails to resolve under this
// project's vitest-pool-workers test harness — any `logger.warn/error/
// deprecate` call inside a dialect constructor throws ("Cannot read
// properties of undefined (reading 'red')"). Not fixable from here;
// `initializeDriver()` and the sqlite defaults below instead avoid ever
// calling into that path.
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
  // Plain console, not colorette-colored: no TTY to render ANSI codes here,
  // and colorette isn't reliable to resolve in this harness (see above).
  warn: (message: string) => console.warn(message),
  error: (message: string) => console.error(message),
  deprecate: (message: string) => console.warn(message),
}

// `loadDialect` deliberately types the base dialect class's instance as
// `unknown` — this file otherwise never calls an inherited member by name,
// so there is nothing to type-check against. `destroy()` below is the one
// exception: it calls `super.destroy()` to reuse knex's own pool-teardown
// sequence, so the instance type is refined with just that one member typed
// (an intersection keeps every other inherited member available as
// `unknown`, same as before).
type KnexClientInstance = Record<string, unknown> & {
  destroy(callback?: (err?: unknown) => void): Promise<void>
  transaction(container: unknown, config?: unknown, outerTx?: unknown): unknown
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- mirrors knex's own public `Knex<TRecord, TResult>` signature (node_modules/knex/types/index.d.ts); widening it would diverge from knex's generics and break `.select()`/`.selec()` type-checking.
export function createKnexClient<TRecord extends {} = any, TResult = unknown[]>(
  adapter: DriverAdapter,
  knexOptions: Record<string, unknown> = {},
): KnexType<TRecord, TResult> {
  const Base = loadDialect(adapter.dialect) as new (...args: never[]) => KnexClientInstance

  class CfKnexClient extends Base {
    // knex's base Client constructor calls this whenever `config.connection`
    // is truthy, and each dialect's implementation tries to `require()` the
    // real native driver package (mysql2/pg/sqlite3) — unavailable in
    // workerd and unnecessary, since `adapter` supplies connections instead.
    // Nothing below reads `this.driver`, so no-opping this is safe.
    initializeDriver() {}

    // Deliberately NOT overriding `acquireConnection` / `releaseConnection`
    // (knex's higher-level, per-query API): the base `Client` implementation
    // of those two calls `this.pool.acquire()` / `this.pool.release()`,
    // which is exactly what makes knex's tarn pool real. Overriding them
    // directly — this project's first attempt — calls straight into
    // `adapter` once per query and bypasses tarn entirely, so the pool
    // never tracks a handle and never reaps it; see `DriverAdapter`'s doc
    // comment in ./types.ts for the fallout that caused. Overriding the
    // lower-level hooks below instead lets tarn own pooling and only calls
    // into `adapter` when tarn itself decides to create or evict a handle.

    async acquireRawConnection() {
      return adapter.acquire()
    }

    async destroyRawConnection(handle: unknown) {
      await adapter.release(handle)
    }

    // knex's stock mysql2 dialect implements this as `connection &&
    // !connection._fatalError && !connection._protocolError &&
    // !connection._closing && !connection.stream.destroyed`
    // (node_modules/knex/lib/dialects/mysql2/index.js) — it assumes the
    // pooled handle is always a live mysql2 socket with those exact fields.
    // That is not true in general: `adapter` owns the handle, and for the
    // tidb-http/d1/libsql adapters this same class is reused for, it may not
    // have any of them. Reading `.stream.destroyed` on one of those handles
    // would throw (not just return false), which tarn would treat as
    // "invalid, discard immediately" — silently defeating pooling on every
    // acquire. Handle
    // liveness is genuinely the adapter's concern, not the pool's — but
    // "the adapter's concern" has to mean something the adapter can act on,
    // not just a comment here promising it does: `DriverAdapter.validate`
    // (src/core/types.ts) is the hook for that. Delegate to it when an
    // adapter implements it (a handle that can go stale between queries,
    // e.g. mysql2's TCP connection, needs this to avoid the pool handing
    // out a connection MySQL already killed server-side); default to always
    // valid when it doesn't (HTTP-backed and binding-backed handles can't go
    // stale this way, and knex's own stricter default would wrongly discard
    // them).
    validateConnection(handle: unknown): boolean {
      return adapter.validate ? adapter.validate(handle) : true
    }

    async _query(handle: unknown, obj: Record<string, unknown>) {
      const raw = await adapter.execute(handle, obj.sql as string, (obj.bindings as unknown[]) ?? [])
      return toKnexResponse(adapter.dialect, raw, obj)
    }

    // `adapter.capabilities.streaming` on its own is only a claim; `adapter.
    // stream` existing is the proof. Gating on both is what stops a
    // future adapter that sets the flag without ever implementing the
    // method from reaching `adapter.stream(...)` below and crashing on
    // "not a function" instead of failing with this file's own typed error
    // (see src/core/types.ts's `DriverAdapter.stream` doc — this is the
    // same reasoning `validateConnection` above already applies to
    // `adapter.validate`).
    //
    // Must return a Promise that genuinely settles on the outcome of the
    // stream, not merely a Promise that always resolves once some async work
    // runs: knex's own postgres `_stream` (node_modules/knex/lib/dialects/
    // postgres/index.js) — the contract this matches — resolves on
    // completion, rejects on error, and emits on the stream in the error
    // case as well, all three. A version that only ever resolves (or only
    // ever emits on the stream without also rejecting) would let a caller
    // who `await`s `db(t).stream()`'s returned promise (or a `.stream()`
    // callback's own return value) see success on a stream that actually
    // failed partway through.
    //
    // Whether that promise settling promptly actually keeps the pooled
    // connection held for exactly this long, though, depends on which of
    // knex's *two* independent release paths gets there first — this method
    // only controls one of them, and which path is even reachable differs
    // outside vs. inside `db.transaction()`.
    //
    // Outside a transaction: `Runner.ensureConnection`'s own `finally {
    // await this.client.releaseConnection(...) }` (node_modules/knex/lib/
    // execution/runner.js) does genuinely await this method's returned
    // promise before releasing. But `Runner.stream()` also independently
    // registers `stream.on('close', () => this.client.releaseConnection(...))`
    // on the output Transform *at creation time* — this fires the instant a
    // consumer stops early (a `break` inside `for await`, which destroys the
    // Transform), with no dependency on this method's promise at all. Both
    // of those calls reach the same real, base client, so either one can
    // genuinely return the pooled connection to the pool while this method's
    // own cleanup is still running.
    //
    // Inside `db.transaction()`, the picture is different, not just "the
    // first path doesn't apply": query builders built from `trx(...)` run
    // against `trxClient`, not the base client (`makeTransactor(trx,
    // connection, trxClient)` → `makeKnex(trxClient)`), and `makeTxClient`
    // (node_modules/knex/lib/execution/transaction.js) overrides
    // `trxClient.releaseConnection` with a no-op (`() => Promise.resolve()`).
    // So the *same* `stream.on('close', ...)` handler still fires on an early
    // exit inside a transaction, but the call it makes resolves immediately
    // without touching the pool, since `this.client` there is `trxClient`.
    // That does not make a transaction's connection immune to a premature
    // release, though: `Transaction.prototype.acquireConnection`'s own
    // `finally` block calls the *real* base client's `releaseConnection`
    // once the transaction callback's promise settles and commit/rollback
    // has fully resolved — independently of whether some other, unawaited,
    // overlapping `stream()` call on that same transaction is still
    // mid-cleanup. A driver adapter whose own `stream()` cleanup can still be
    // issuing queries after an early exit (src/adapters/pg.ts's cursor
    // teardown, for instance) has to defend against both of these — the
    // non-transactional Transform-'close' race and this narrower
    // transactional one — the same way, because both ultimately call the
    // real client's `releaseConnection`; see src/adapters/pg.ts's
    // `handlesMidTeardown` comment for how it does that.
    _stream(handle: unknown, obj: Record<string, unknown>, stream: StreamSink): Promise<void> {
      if (!adapter.capabilities.streaming || !adapter.stream) {
        throw CfKnexError.unsupported(adapter.driver, 'streaming', adapter.hints?.streaming ?? 'Use .limit()/.offset() to paginate.')
      }
      // Both stock dialects this adapter's streaming replaces guard this
      // identically — node_modules/knex/lib/dialects/postgres/index.js's
      // `_stream` and node_modules/knex/lib/dialects/mysql/index.js's
      // `_stream` (the mysql2 dialect inherits it unchanged) both open with
      // `if (!obj.sql) throw new Error('The query is empty')` — a
      // synchronous throw, not a rejected promise. knex's own
      // `ensureConnectionStreamCallback` (node_modules/knex/lib/execution/
      // internal/ensure-connection-callback.js) wraps the call this method
      // is reached through in a try/catch specifically to turn a synchronous
      // throw here into a `stream.emit('error', …)` plus a normal rejection,
      // so matching the stock dialects' exact shape (rather than inventing a
      // resolved-promise no-op instead) is what stays inside that already-
      // handled path.
      if (!obj.sql) throw new Error('The query is empty')

      const rows = adapter.stream(handle, obj.sql as string, (obj.bindings as unknown[]) ?? [])
      return (async () => {
        try {
          for await (const row of rows) {
            // A `false` return means the sink's internal buffer is full and
            // it has not caught up — writing the next row anyway (the
            // original draft of this method did) buffers the entire result
            // set in `stream`'s own memory the moment the consumer falls
            // behind for even one row, which defeats the only reason to
            // stream in the first place. `waitForDrain` also resolves the
            // race the other way (the sink closing instead of draining) so
            // this can never hang forever on a consumer that already left.
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

    // knex's own `Client.transaction()` (node_modules/knex/lib/client.js)
    // has no notion of `adapter.capabilities` and will happily hand back a
    // `Transaction` that issues BEGIN/COMMIT/ROLLBACK as ordinary queries
    // through `_query()` above — for an adapter that cannot guarantee those
    // three statements land on the same underlying session (declared via
    // `capabilities.transactions: false`), that is the worst possible
    // failure: writes appear to succeed and a rollback silently commits
    // instead. Gate it here, the same way `_stream()` above gates streaming.
    //
    // This must return a *rejected Promise*, not throw synchronously: knex's
    // `make-knex.js` `_transaction()` returns whatever this method produces
    // directly and unwrapped whenever a callback container is passed (the
    // common `db.transaction(async trx => {...})` shape) — a synchronous
    // throw here would escape as a thrown exception instead of the rejected
    // promise callers `await`/`.catch()`/`expect(...).rejects` expect.
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
      return super.transaction(container, config, outerTx)
    }

    // knex's own `Client.destroy()` only tears down the pool — which, now
    // that acquire/destroy are wired to real tarn hooks above, does mean
    // every handle tarn still holds gets a `destroyRawConnection` /
    // `adapter.release()` call. But `Client.destroy()` has no notion of
    // `adapter`, so without this override `knex.destroy()` would never
    // reach `adapter.destroy()` and any adapter-level state that outlives
    // individual handles (e.g. src/adapters/mysql2.ts's own bookkeeping)
    // would go untorn-down. `knex.destroy(callback)` (make-knex.js) calls
    // `this.client.destroy(callback)` directly and polymorphically, so
    // overriding `destroy` here is reached the same way the overrides above
    // are. `super.destroy()` first reuses the base pool-teardown sequence
    // (including its own `_ownsPool` guard) before `adapter.destroy()` runs.
    //
    // But `this` is not always the real client: knex's transaction machinery
    // (execution/transaction.js's `makeTxClient`) builds a *transactor*
    // client via `Object.create(client.constructor.prototype)` — sharing
    // this exact prototype, so `trx.destroy()` resolves to this same method
    // — and marks it with an own `transacting: true` property the real
    // client never has. That transactor has no pool of its own (`super.destroy()`
    // already no-ops for it, since its inherited `this.pool` is `undefined`),
    // but nothing before this fix-round stopped `adapter.destroy()` from
    // running anyway: calling `trx.destroy()` inside a transaction would
    // tear down every connection the *adapter* holds, including the one the
    // transaction itself is still using to COMMIT — breaking the parent
    // `db` permanently, not just the transaction. Guard it the same way
    // knex's own pool implicitly does for itself.
    async destroy(callback?: (err?: unknown) => void): Promise<void> {
      if ((this as unknown as { transacting?: boolean }).transacting) {
        if (typeof callback === 'function') callback()
        return
      }
      try {
        await super.destroy()
        await adapter.destroy()
        if (typeof callback === 'function') callback()
      } catch (err) {
        if (typeof callback === 'function') return callback(err)
        throw err
      }
    }
  }

  // sqlite3's own constructor warns (see the module comment above) unless
  // `connection.filename` and `useNullAsDefault` are already set. `filename`
  // is never opened — `adapter` owns the real connection — and
  // `useNullAsDefault: true` is standard, harmless knex practice regardless.
  const dialectDefaults: Record<string, unknown> = adapter.dialect === 'sqlite' ? { useNullAsDefault: true } : {}
  // ':memory:' satisfies the check above only — knex never actually opens
  // it, since `adapter` (not knex) owns the connection.
  const connectionDefault: Record<string, unknown> = adapter.dialect === 'sqlite' ? { filename: ':memory:' } : {}

  // Overrides knex's inherited pool default (`min: 2, max: 10`). This
  // library's documented usage pattern is a fresh client per request, never
  // one cached in a module-level global — Hyperdrive already pools
  // server-side, and reusing a cached knex/socket object across requests
  // throws workerd's "Cannot perform I/O on behalf of a different request".
  // tarn only ever creates connections to satisfy actual pending acquires
  // (`_shouldCreateMoreResources`, node_modules/.pnpm/tarn@3.1.2's
  // Pool.js), so `min: 2` does NOT mean two connections open eagerly up
  // front — a single query against a `min: 2` pool still opens exactly one.
  // The real problem is what happens to that one connection afterward: it
  // is never reclaimed. tarn's reap arithmetic (`maxDestroy = free.length -
  // (min - used.length)`, from the same `check()`) is ≤ 0 whenever at most
  // `min` connections are sitting idle, so the idle-timeout reaper never
  // fires on them. With a fresh client per request and `min: 2`, the one
  // connection that request's query opened is pinned open for the rest of
  // that client's lifetime instead of being reclaimable — exactly backwards
  // for a client that's about to be destroyed at the end of the request
  // anyway. `min: 0` removes that floor entirely, so an idle connection is
  // always eligible for reaping; `max: 5` is a modest per-client ceiling,
  // not a promise every adapter/database combination can sustain
  // concurrently.
  const poolDefault: Record<string, unknown> = { pool: { min: 0, max: 5 } }

  // `client` must always be `CfKnexClient` (a caller-supplied one would
  // defeat this function), and `connection`/`log` must merge with their
  // defaults rather than replace them (an incomplete caller `connection`
  // would otherwise reintroduce the sqlite crash above) — handled
  // explicitly below rather than by spread order. `pool` and everything
  // else override freely: a caller-supplied `pool` (already passed through
  // via this same `restOptions` spread today) fully replaces `poolDefault`
  // above it, exactly like `dialectDefaults`.
  const { connection: callerConnection, log: callerLog, ...restOptions } = knexOptions as Record<string, unknown> & {
    connection?: Record<string, unknown>
    log?: Record<string, unknown>
  }

  return Knex({
    ...dialectDefaults,
    ...poolDefault,
    ...restOptions,
    connection: { ...connectionDefault, ...callerConnection },
    log: { ...DEFAULT_LOG, ...callerLog },
    client: CfKnexClient as unknown as typeof KnexType.Client,
  }) as KnexType<TRecord, TResult>
}
