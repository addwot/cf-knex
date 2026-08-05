import { createMysql2Adapter } from '../adapters/mysql2'
import { createKnexClient } from '../core/client'
import type { Mysql2AdapterOptions } from '../adapters/mysql2'
import type { Knex } from 'knex'

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- mirrors knex's own public `Knex<TRecord, TResult>` signature (src/core/client.ts follows the same pattern).
export function createClient<TRecord extends {} = any, TResult = unknown[]>(
  opts: Mysql2AdapterOptions & { knex?: Record<string, unknown> },
): Knex<TRecord, TResult> {
  return createKnexClient<TRecord, TResult>(createMysql2Adapter(opts), opts.knex)
}
