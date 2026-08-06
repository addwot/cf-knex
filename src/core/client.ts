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
  "knex's own package.json 'browser' field maps Migrator/Seeder to a no-op, and real wrangler/esbuild honours that field when bundling for Workers, so this getter cannot construct a real one here. Run migrations/seeds from your own tooling against the database directly instead: `wrangler d1 migrations` for D1, the Turso/libsql CLI, or a plain Node knex process against Postgres/MySQL — never from inside the Worker."

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
): KnexType<TRecord, TResult> {
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
      return super.transaction(container, config, outerTx)
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
  const { connection: callerConnection, log: callerLog, ...restOptions } = knexOptions as Record<string, unknown> & {
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
  const newKnex = makeKnex(new CfKnexClient(resolvedConfig)) as KnexType<TRecord, TResult>
  hardenMigrationAccessors(newKnex)
  const userParams = (resolvedConfig as { userParams?: unknown }).userParams
  if (userParams) (newKnex as unknown as { userParams: unknown }).userParams = userParams
  return newKnex
}
