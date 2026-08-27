import type { Knex as KnexType } from 'knex'
import makeKnex from 'knex/lib/knex-builder/make-knex.js'
import Client_MySQL2 from 'knex/lib/dialects/mysql2/index.js'
import Client_PG from 'knex/lib/dialects/postgres/index.js'
import Client_SQLite3 from 'knex/lib/dialects/sqlite3/index.js'
import type { DisposableKnex } from './disposable'
import { CfKnexError } from './errors'
import { toKnexResponse } from './response'
import type { Dialect, DriverAdapter } from './types'

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

class StreamSinkClosed extends Error {}

function isSinkAbortedByReader(err: unknown): boolean {
  return err instanceof Error && (err as { code?: unknown }).code === 'ABORT_ERR' && err.name === 'AbortError'
}

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

const DIALECT_CLASSES: Record<Dialect, unknown> = {
  mysql: Client_MySQL2,
  postgres: Client_PG,
  sqlite: Client_SQLite3,
}

function loadDialect(dialect: Dialect): new (...args: never[]) => unknown {
  const Base = DIALECT_CLASSES[dialect]
  if (typeof Base !== 'function') {
    throw new CfKnexError('INCOMPATIBLE_KNEX', `'knex/lib/dialects' entry for '${dialect}' did not export a constructor`)
  }
  return Base as new (...args: never[]) => unknown
}

const DEFAULT_LOG = {
  warn: (message: string) => console.warn(message),
  error: (message: string) => console.error(message),
  deprecate: (message: string) => console.warn(message),
}

const DESTROY_TIMEOUT_MS = 6_000

const teardowns = new WeakMap<object, Promise<void>>()

type TeardownOutcome = { state: 'ok' } | { state: 'failed'; error: unknown } | { state: 'timed-out' }

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

const poolTimedOutMessage = (ms: number): string =>
  `cf-knex: destroy() stopped waiting for the connection pool after ${ms}ms and returned. Nothing was force-closed — the pool is still draining. ` +
  'A connection was still checked out, which almost always means a transaction from `const trx = await db.transaction()` was never committed or rolled back. ' +
  'On TiDB Cloud Serverless and Turso the locks it holds stay held server-side until the backend expires them. ' +
  'Use `await using trx = await db.transaction()`, or the callback form `db.transaction(async trx => { … })`, which releases on every path including a throw.'

const adapterTimedOutMessage = (driver: string, ms: number): string =>
  `cf-knex: the ${driver} adapter's own teardown did not finish within the ${ms}ms left of the destroy() budget; destroy() returned anyway. Connections it still held may not be closed yet.`

async function runTeardown(
  poolTeardown: Promise<void>,
  adapter: DriverAdapter,
  budgetMs: number,
  warn: (message: string) => void,
): Promise<void> {
  const startedAt = Date.now()
  const pool = await settleWithin(poolTeardown, budgetMs)
  if (pool.state === 'timed-out') warn(poolTimedOutMessage(budgetMs))

  const remainingMs = Math.max(0, budgetMs - (Date.now() - startedAt))
  const teardown = await settleWithin(adapter.destroy(), remainingMs)
  if (teardown.state === 'timed-out') warn(adapterTimedOutMessage(adapter.driver, remainingMs))

  if (pool.state === 'failed') throw pool.error
  if (teardown.state === 'failed') throw teardown.error
}

async function disposeTransactor(transactor: object): Promise<void> {
  const trx = transactor as {
    isCompleted?: () => boolean
    rollback?: (error?: unknown) => Promise<unknown>
  }
  if (typeof trx.isCompleted === 'function' && trx.isCompleted()) return
  if (typeof trx.rollback !== 'function') return
  await trx.rollback()
}

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

type KnexClientInstance = Record<string, unknown> & {
  destroy(callback?: (err?: unknown) => void): Promise<void>
  transaction(container: unknown, config?: unknown, outerTx?: unknown): unknown
  prepBindings(bindings: unknown[]): unknown[]
}

const MIGRATION_ACCESSORS = [
  ['migrate', 'db.migrate'],
  ['seed', 'db.seed'],
] as const

const MIGRATION_UNAVAILABLE_HINT =
  "Knex.js's own package.json 'browser' field maps Migrator/Seeder to a no-op, and real wrangler/esbuild honours that field when bundling for Workers, so this getter cannot construct a real one here. Run migrations/seeds from your own tooling against the database directly instead: `wrangler d1 migrations` for D1, the Turso/libsql CLI, or a plain Node Knex.js process against Postgres/MySQL — never from inside the Worker."

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

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- mirrors knex's public `Knex<TRecord, TResult>` signature (node_modules/knex/types/index.d.ts); widening would break `.select()` type-checking.
export function createKnexClient<TRecord extends {} = any, TResult = unknown[]>(
  adapter: DriverAdapter,
  knexOptions: Record<string, unknown> = {},
): DisposableKnex<TRecord, TResult> {
  const { destroyTimeoutMs, ...clientOptions } = knexOptions as Record<string, unknown> & {
    destroyTimeoutMs?: number
  }
  const destroyBudgetMs =
    typeof destroyTimeoutMs === 'number' && Number.isFinite(destroyTimeoutMs) && destroyTimeoutMs > 0
      ? destroyTimeoutMs
      : DESTROY_TIMEOUT_MS

  const Base = loadDialect(adapter.dialect) as new (config: Record<string, unknown>) => KnexClientInstance

  class CfKnexClient extends Base {
    initializeDriver() {}

    async acquireRawConnection() {
      return adapter.acquire()
    }

    async destroyRawConnection(handle: unknown) {
      await adapter.release(handle)
    }

    validateConnection(handle: unknown): boolean {
      return adapter.validate ? adapter.validate(handle) : true
    }

    prepBindings(bindings: unknown[]): unknown[] {
      if (adapter.dialect !== 'sqlite') return super.prepBindings(bindings)
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

    _stream(handle: unknown, obj: Record<string, unknown>, stream: StreamSink): Promise<void> {
      if (!adapter.capabilities.streaming || !adapter.stream) {
        throw CfKnexError.unsupported(adapter.driver, 'streaming', adapter.hints?.streaming ?? 'Use .limit()/.offset() to paginate.')
      }
      if (!obj.sql) throw new Error('The query is empty')

      const rows = adapter.stream(handle, obj.sql as string, (obj.bindings as unknown[]) ?? [])
      return (async () => {
        try {
          for await (const row of rows) {
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

    async destroy(callback?: (err?: unknown) => void): Promise<void> {
      if ((this as unknown as { transacting?: boolean }).transacting) {
        if (typeof callback === 'function') callback()
        return
      }

      let teardown = teardowns.get(this)
      if (!teardown) {
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

  const dialectDefaults: Record<string, unknown> = adapter.dialect === 'sqlite' ? { useNullAsDefault: true } : {}
  const connectionDefault: Record<string, unknown> = adapter.dialect === 'sqlite' ? { filename: ':memory:' } : {}

  const poolDefault: Record<string, unknown> = { pool: { min: 0, max: 5 } }

  const { connection: callerConnection, log: callerLog, ...restOptions } = clientOptions as Record<string, unknown> & {
    connection?: Record<string, unknown>
    log?: Record<string, unknown>
  }

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
  defineAsyncDispose(newKnex, () => newKnex.destroy())
  const userParams = (resolvedConfig as { userParams?: unknown }).userParams
  if (userParams) (newKnex as unknown as { userParams: unknown }).userParams = userParams
  return newKnex
}
