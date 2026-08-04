import { createRequire } from 'node:module'
import Knex from 'knex'
import type { Knex as KnexType } from 'knex'
import { CfKnexError } from './errors'
import { toKnexResponse } from './response'
import type { Dialect, DriverAdapter } from './types'

// `node:module` types are declared ambiently in ./node-module.d.ts — see
// that file for why.
const require_ = createRequire(import.meta.url)

const DIALECT_MODULES: Record<Dialect, string> = {
  mysql: 'knex/lib/dialects/mysql2',
  postgres: 'knex/lib/dialects/postgres',
  sqlite: 'knex/lib/dialects/sqlite3',
}

function loadDialect(dialect: Dialect): new (...args: never[]) => unknown {
  let mod: { default?: unknown } | unknown
  try {
    mod = require_(DIALECT_MODULES[dialect])
  } catch (cause) {
    throw new CfKnexError(
      'INCOMPATIBLE_KNEX',
      `cannot load '${DIALECT_MODULES[dialect]}'. cf-knex supports knex ^3.1.0; found an incompatible layout. Cause: ${String(cause)}`,
    )
  }
  const Base = (mod as { default?: unknown }).default ?? mod
  if (typeof Base !== 'function') {
    throw new CfKnexError('INCOMPATIBLE_KNEX', `'${DIALECT_MODULES[dialect]}' did not export a constructor`)
  }
  return Base as new (...args: never[]) => unknown
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- mirrors knex's own public `Knex<TRecord, TResult>` signature (node_modules/knex/types/index.d.ts); widening it would diverge from knex's generics and break `.select()`/`.selec()` type-checking.
export function createKnexClient<TRecord extends {} = any, TResult = unknown[]>(
  adapter: DriverAdapter,
  knexOptions: Record<string, unknown> = {},
): KnexType<TRecord, TResult> {
  const Base = loadDialect(adapter.dialect) as new (...args: never[]) => Record<string, unknown>

  class CfKnexClient extends Base {
    // knex's base Client constructor unconditionally calls this whenever
    // `config.connection` is truthy (see node_modules/knex/lib/client.js).
    // The dialect implementation tries to `require()` the real native driver
    // package (mysql2/pg/sqlite3), which cannot load inside workerd — and
    // its own failure-handling path (`this.logger.error`) throws too, since
    // knex's colorette-based logger doesn't resolve there either. We supply
    // connections via `adapter`, not a real driver, so there is nothing for
    // this to initialize; every method that would otherwise consult
    // `this.driver` (acquireConnection/releaseConnection/_query) is
    // overridden below and never touches it.
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

  // The sqlite3 dialect's own constructor (node_modules/knex/lib/dialects/sqlite3/index.js)
  // unconditionally calls `this.logger.warn(...)` twice — once when
  // `connection.filename` is unset, once when `useNullAsDefault` is unset —
  // to nudge real sqlite3 users toward safer config. knex's Logger colors
  // every warn/error/deprecate message via `colorette` (`color.yellow(...)`
  // / `color.red(...)`, evaluated eagerly as a call argument), and colorette
  // does not resolve to a usable module inside workerd, so any warn call
  // throws `Cannot read properties of undefined (reading 'yellow')` instead
  // of logging — before we ever get a chance to run. There is no adapter
  // config to satisfy these warnings with real values (the adapter, not
  // knex, owns the actual connection), so default them away for sqlite;
  // `filename` is inert here since `execute`/`acquire` never read it.
  const dialectDefaults: Record<string, unknown> =
    adapter.dialect === 'sqlite' ? { connection: { filename: ':memory:' }, useNullAsDefault: true } : { connection: {} }

  return Knex({
    client: CfKnexClient as unknown as typeof KnexType.Client,
    ...dialectDefaults,
    // Route any other warn/error/deprecate call knex might still make
    // through plain console methods. This does not protect against the
    // colorette crash above (that happens before a custom log function is
    // even reached — see node_modules/knex/lib/logger.js `warn`/`error`),
    // but it keeps output readable: ANSI color codes are meaningless noise
    // in a Workers log viewer even where colorette does resolve.
    log: {
      warn: (message: string) => console.warn(message),
      error: (message: string) => console.error(message),
      deprecate: (message: string) => console.warn(message),
    },
    ...knexOptions,
  }) as KnexType<TRecord, TResult>
}
