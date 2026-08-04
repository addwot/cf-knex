import Knex from 'knex'
import type { Knex as KnexType } from 'knex'
// knex ships types only for its public entry point; these deep CJS dialect
// paths have no shipped declarations — see ./knex-dialects.d.ts.
import Client_MySQL2 from 'knex/lib/dialects/mysql2'
import Client_PG from 'knex/lib/dialects/postgres'
import Client_SQLite3 from 'knex/lib/dialects/sqlite3'
import { CfKnexError } from './errors'
import { toKnexResponse } from './response'
import type { Dialect, DriverAdapter } from './types'

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

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- mirrors knex's own public `Knex<TRecord, TResult>` signature (node_modules/knex/types/index.d.ts); widening it would diverge from knex's generics and break `.select()`/`.selec()` type-checking.
export function createKnexClient<TRecord extends {} = any, TResult = unknown[]>(
  adapter: DriverAdapter,
  knexOptions: Record<string, unknown> = {},
): KnexType<TRecord, TResult> {
  const Base = loadDialect(adapter.dialect) as new (...args: never[]) => Record<string, unknown>

  class CfKnexClient extends Base {
    // knex's base Client constructor calls this whenever `config.connection`
    // is truthy, and each dialect's implementation tries to `require()` the
    // real native driver package (mysql2/pg/sqlite3) — unavailable in
    // workerd and unnecessary, since `adapter` supplies connections instead.
    // Nothing below reads `this.driver`, so no-opping this is safe.
    initializeDriver() {}

    async acquireConnection() {
      return adapter.acquire()
    }

    async releaseConnection(handle: unknown) {
      await adapter.release(handle)
    }

    async _query(handle: unknown, obj: Record<string, unknown>) {
      const raw = await adapter.execute(handle, obj.sql as string, (obj.bindings as unknown[]) ?? [])
      return toKnexResponse(adapter.dialect, raw, obj)
    }

    _stream() {
      throw CfKnexError.unsupported(adapter.driver, 'streaming', 'Use .limit()/.offset() to paginate.')
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

  // `client` must always be `CfKnexClient` (a caller-supplied one would
  // defeat this function), and `connection`/`log` must merge with their
  // defaults rather than replace them (an incomplete caller `connection`
  // would otherwise reintroduce the sqlite crash above) — handled
  // explicitly below rather than by spread order. Everything else overrides
  // freely.
  const { connection: callerConnection, log: callerLog, ...restOptions } = knexOptions as Record<string, unknown> & {
    connection?: Record<string, unknown>
    log?: Record<string, unknown>
  }

  return Knex({
    ...dialectDefaults,
    ...restOptions,
    connection: { ...connectionDefault, ...callerConnection },
    log: { ...DEFAULT_LOG, ...callerLog },
    client: CfKnexClient as unknown as typeof KnexType.Client,
  }) as KnexType<TRecord, TResult>
}
