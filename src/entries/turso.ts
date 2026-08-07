import { createLibsqlAdapter } from '../adapters/libsql'
import { createKnexClient } from '../core/client'
import type { LibsqlAdapterOptions } from '../adapters/libsql'
import type { DisposableKnex } from '../core/disposable'

export type { DisposableKnex, DisposableTransaction } from '../core/disposable'

// LibsqlAdapterOptions already carries intMode, so spreading it through
// here (rather than restating fields by hand) keeps it reachable.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- mirrors knex's own public `Knex<TRecord, TResult>` signature (src/core/client.ts follows the same pattern).
export function createClient<TRecord extends {} = any, TResult = unknown[]>(
  opts: LibsqlAdapterOptions & { knex?: Record<string, unknown> },
): DisposableKnex<TRecord, TResult> {
  return createKnexClient<TRecord, TResult>(createLibsqlAdapter(opts), opts.knex)
}
