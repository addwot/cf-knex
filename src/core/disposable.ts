import type { Knex } from 'knex'

type AsyncDisposeKey = typeof Symbol extends { readonly asyncDispose: infer S extends symbol } ? S : never

/**
 * A transactor that `await using` can manage. Disposal rolls back if the caller
 * never committed or rolled back; a completed transaction disposes to a no-op.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- mirrors knex's own public `Knex.Transaction<TRecord, TResult>` signature; widening it would diverge from knex's generics.
export type DisposableTransaction<TRecord extends {} = any, TResult = unknown[]> = Knex.Transaction<TRecord, TResult> &
  Record<AsyncDisposeKey, () => Promise<void>>

/**
 * Stock `Knex` plus an async disposer, so `await using db = createClient(…)`
 * tears the pool down at scope exit.
 *
 * The `transaction` overload gives `await using trx = await db.transaction()`
 * a disposable transactor: its parameter list mirrors knex's own
 * `transaction(transactionScope?: null, config?)` deliberately, since a bare
 * `transaction(): …` loses overload resolution to knex's own — matching
 * arity wins, not ordering. Every other call shape falls through to `Knex`.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- mirrors knex's own public `Knex<TRecord, TResult>` signature (src/core/client.ts follows the same pattern).
export type DisposableKnex<TRecord extends {} = any, TResult = unknown[]> = {
  transaction(
    transactionScope?: null,
    config?: Knex.TransactionConfig,
  ): Promise<DisposableTransaction<TRecord, TResult>>
} & Knex<TRecord, TResult> &
  Record<AsyncDisposeKey, () => Promise<void>>
