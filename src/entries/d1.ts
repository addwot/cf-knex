import { createD1Adapter } from '../adapters/d1'
import { createKnexClient } from '../core/client'
import type { D1AdapterOptions } from '../adapters/d1'
import type { Knex } from 'knex'

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- mirrors knex's own public `Knex<TRecord, TResult>` signature (src/core/client.ts follows the same pattern).
export function createClient<TRecord extends {} = any, TResult = unknown[]>(
  opts: D1AdapterOptions & { knex?: Record<string, unknown> },
): Knex<TRecord, TResult> {
  return createKnexClient<TRecord, TResult>(createD1Adapter(opts), opts.knex)
}
