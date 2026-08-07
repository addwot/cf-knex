import { createPgAdapter } from '../adapters/pg'
import { createKnexClient } from '../core/client'
import type { PgAdapterOptions } from '../adapters/pg'
import type { DisposableKnex } from '../core/disposable'

export type { DisposableKnex, DisposableTransaction } from '../core/disposable'

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- mirrors knex's own public `Knex<TRecord, TResult>` signature (src/core/client.ts follows the same pattern).
export function createClient<TRecord extends {} = any, TResult = unknown[]>(
  opts: PgAdapterOptions & { knex?: Record<string, unknown> },
): DisposableKnex<TRecord, TResult> {
  return createKnexClient<TRecord, TResult>(createPgAdapter(opts), opts.knex)
}
