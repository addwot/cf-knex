import { createD1Adapter } from './adapters/d1'
import { createLibsqlAdapter } from './adapters/libsql'
import { createMysql2Adapter } from './adapters/mysql2'
import { createPgAdapter } from './adapters/pg'
import { createTidbHttpAdapter } from './adapters/tidb-http'
import { createKnexClient } from './core/client'
import { CfKnexError } from './core/errors'
import { inferDriver, isD1Binding } from './core/infer'
import type { ClientConfig, DriverAdapter, DriverName } from './core/types'
import type { Knex } from 'knex'

export { CfKnexError } from './core/errors'
export type { CfKnexErrorCode } from './core/errors'
export type { ClientConfig, Credentials, DriverAdapter, DriverName, Engine, RawResult } from './core/types'

// `inferDriver` only confirms that `config` names exactly one connection
// shape and that the resulting driver belongs to `config.engine` — it does
// NOT confirm that shape is the one the chosen driver actually needs. An
// explicit `config.driver` skips shape-based inference entirely (see
// `infer()` in ./core/infer.ts), so e.g. `{ engine: 'sqlite', driver:
// 'libsql', binding }` passes `inferDriver` — 'binding' is a valid shape,
// 'libsql' is valid for 'sqlite' — yet supplies libsql with no `url` at all.
// Reproduced concretely: that exact config previously reached
// `createLibsqlAdapter({ url: undefined })` and only failed later, on the
// first query, with `LibsqlError URL_INVALID: The URL 'undefined' is not in
// a valid format` — a driver-internal error about the string "undefined",
// not something naming the actual problem. `pg`/`mysql2`'s own factories
// already guard this themselves (`resolveConfig`/its mysql2 equivalent both
// throw `NO_CONNECTION` when none of `url`/`connection`/`hyperdrive` is
// set), so only the three drivers without that self-check need a guard here.
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
      return createTidbHttpAdapter({ url: config.url })
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

// `connectionString` must actually be a string, not merely present: an env
// value shaped like `{ connectionString: 123 }` (or `{ connectionString:
// undefined }`, which still satisfies `'connectionString' in value`) used to
// reach a bare `.startsWith()` call below and throw a raw `TypeError`
// instead of either matching or cleanly not matching. Malformed-but-present
// now simply does not match, the same as any other unrelated env value —
// consistent with `isD1Binding` (imported from ./core/infer, not
// reimplemented here) checking that `prepare` is actually a function, not
// just that the key exists.
function isHyperdriveBinding(value: unknown): value is { connectionString: string } {
  return typeof value === 'object' && value !== null && typeof (value as { connectionString?: unknown }).connectionString === 'string'
}

/**
 * Scans `env`'s own values for exactly one D1 or Hyperdrive-shaped binding
 * and builds a client from it — the zero-config path for a Worker with a
 * single database binding.
 */
export function fromEnv(env: Record<string, unknown>, opts: { prefer?: DriverName } = {}): Knex {
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
