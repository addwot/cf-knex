import { createD1Adapter } from './adapters/d1'
import { createLibsqlAdapter } from './adapters/libsql'
import { createMysql2Adapter } from './adapters/mysql2'
import { createPgAdapter } from './adapters/pg'
import { createTidbHttpAdapter } from './adapters/tidb-http'
import { createKnexClient } from './core/client'
import { CfKnexError } from './core/errors'
import { inferDriver } from './core/infer'
import type { ClientConfig, DriverAdapter, DriverName } from './core/types'
import type { Knex } from 'knex'

export { CfKnexError } from './core/errors'
export type { CfKnexErrorCode } from './core/errors'
export type { ClientConfig, Credentials, DriverAdapter, DriverName, Engine, RawResult } from './core/types'

// `inferDriver` has already validated `config` by the time this runs — every
// branch below can assume its required field (`url`/`binding`) is present,
// even though `ClientConfig` types them optional.
function buildAdapter(config: ClientConfig, driver: DriverName): DriverAdapter {
  switch (driver) {
    case 'd1':
      return createD1Adapter({ binding: config.binding as never })
    case 'libsql':
      return createLibsqlAdapter({ url: config.url as string, authToken: config.authToken })
    case 'tidb-http':
      return createTidbHttpAdapter({ url: config.url as string })
    case 'pg':
      return createPgAdapter({ url: config.url, connection: config.connection, hyperdrive: config.hyperdrive })
    case 'mysql2':
      return createMysql2Adapter({ url: config.url, connection: config.connection, hyperdrive: config.hyperdrive })
    default: {
      const exhaustive: never = driver
      throw new CfKnexError('UNKNOWN_DRIVER', `no adapter builder for driver '${String(exhaustive)}'`)
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- mirrors knex's own public `Knex<TRecord, TResult>` signature (src/core/client.ts follows the same pattern).
export function createClient<TRecord extends {} = any, TResult = unknown[]>(
  config: ClientConfig,
): Knex<TRecord, TResult> {
  const driver = inferDriver(config)
  return createKnexClient<TRecord, TResult>(buildAdapter(config, driver), config.knex)
}

/**
 * Scans `env`'s own values for exactly one D1 or Hyperdrive-shaped binding
 * and builds a client from it — the zero-config path for a Worker with a
 * single database binding. Duck-typed the same way `inferDriver`'s
 * `isD1Binding` is (a `prepare` method for D1; a `connectionString` field for
 * Hyperdrive), since `env`'s bindings arrive with no declared type here.
 */
export function fromEnv(env: Record<string, unknown>, opts: { prefer?: DriverName } = {}): Knex {
  const found: ClientConfig[] = []
  for (const value of Object.values(env)) {
    if (value && typeof value === 'object' && typeof (value as { prepare?: unknown }).prepare === 'function') {
      found.push({ engine: 'sqlite', binding: value })
    } else if (value && typeof value === 'object' && 'connectionString' in value) {
      const hd = value as { connectionString: string }
      found.push({ engine: hd.connectionString.startsWith('mysql') ? 'mysql' : 'postgres', hyperdrive: value as never })
    }
  }
  if (found.length === 0) throw new CfKnexError('NO_CONNECTION', 'fromEnv found no D1 or Hyperdrive binding')
  if (found.length > 1 && !opts.prefer) {
    const names = found.map((c) => inferDriver(c)).join(', ')
    throw new CfKnexError('AMBIGUOUS_CONNECTION', `fromEnv found multiple candidates (${names}) — pass { prefer }`)
  }
  const chosen = opts.prefer ? found.find((c) => inferDriver(c) === opts.prefer) : found[0]
  if (!chosen) throw new CfKnexError('NO_CONNECTION', `no binding matched prefer='${opts.prefer}'`)
  return createClient(chosen)
}
