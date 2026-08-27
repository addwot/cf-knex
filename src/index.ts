import { createD1Adapter } from './adapters/d1'
import { createLibsqlAdapter } from './adapters/libsql'
import { createMysql2Adapter } from './adapters/mysql2'
import { createPgAdapter } from './adapters/pg'
import { createTidbHttpAdapter } from './adapters/tidb-http'
import { createKnexClient } from './core/client'
import { CfKnexError } from './core/errors'
import { inferDriver, isD1Binding } from './core/infer'
import type { ClientConfig, DriverAdapter, DriverName } from './core/types'
import type { DisposableKnex } from './core/disposable'

export { CfKnexError } from './core/errors'
export type { CfKnexErrorCode } from './core/errors'
export type { DisposableKnex, DisposableTransaction } from './core/disposable'
export type { ClientConfig, Credentials, DriverAdapter, DriverName, Engine, RawResult } from './core/types'

function buildAdapter(config: ClientConfig, driver: DriverName): DriverAdapter {
  switch (driver) {
    case 'd1':
      if (config.binding === undefined) {
        throw new CfKnexError('NO_CONNECTION', "driver 'd1' requires 'binding', which this config does not have")
      }
      return createD1Adapter({ binding: config.binding as never })
    case 'libsql':
      if (config.url === undefined) {
        throw new CfKnexError('NO_CONNECTION', "driver 'libsql' requires 'url', which this config does not have")
      }
      return createLibsqlAdapter({ url: config.url, authToken: config.authToken })
    case 'tidb-http':
      if (config.url === undefined) {
        throw new CfKnexError('NO_CONNECTION', "driver 'tidb-http' requires 'url', which this config does not have")
      }
      return createTidbHttpAdapter({ url: config.url, timeoutMs: config.timeoutMs, fetch: config.fetch })
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
): DisposableKnex<TRecord, TResult> {
  const driver = inferDriver(config)
  return createKnexClient<TRecord, TResult>(buildAdapter(config, driver), config.knex)
}

function isHyperdriveBinding(value: unknown): value is { connectionString: string } {
  return typeof value === 'object' && value !== null && typeof (value as { connectionString?: unknown }).connectionString === 'string'
}

/**
 * Scans `env`'s own values for exactly one D1 or Hyperdrive-shaped binding
 * and builds a client from it — the zero-config path for a Worker with a
 * single database binding.
 */
export function fromEnv(env: Record<string, unknown>, opts: { prefer?: DriverName } = {}): DisposableKnex {
  const found: ClientConfig[] = []
  for (const value of Object.values(env)) {
    if (isD1Binding(value)) {
      found.push({ engine: 'sqlite', binding: value })
    } else if (isHyperdriveBinding(value)) {
      found.push({ engine: value.connectionString.startsWith('mysql') ? 'mysql' : 'postgres', hyperdrive: value as never })
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
