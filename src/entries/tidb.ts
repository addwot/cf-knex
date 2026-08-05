import { createTidbHttpAdapter } from '../adapters/tidb-http'
import { createKnexClient } from '../core/client'
import type { TidbHttpAdapterOptions } from '../adapters/tidb-http'
import type { Knex } from 'knex'

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- mirrors knex's own public `Knex<TRecord, TResult>` signature (src/core/client.ts follows the same pattern).
export function createClient<TRecord extends {} = any, TResult = unknown[]>(
  opts: TidbHttpAdapterOptions & { knex?: Record<string, unknown> },
): Knex<TRecord, TResult> {
  return createKnexClient<TRecord, TResult>(createTidbHttpAdapter(opts), opts.knex)
}
