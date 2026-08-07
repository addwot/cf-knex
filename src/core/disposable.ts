import type { Knex } from 'knex'

/**
 * `Symbol.asyncDispose`'s type where the consumer's `lib` declares it
 * (`esnext.disposable`, or ES2023+), `never` everywhere else — and
 * `Record<never, …>` is `{}`, so these types stay valid on a consumer still on
 * `lib: ["es2022"]` rather than erroring on a symbol they have never heard of.
 * They just don't see the disposer, which is honest: `await using` is a syntax
 * error for them anyway, and `db.destroy()` still works.
 *
 * `infer S extends symbol` is load-bearing — unconstrained, the key widens to
 * `symbol`, making this a symbol index signature that erases every `Knex` member.
 *
 * Not a `unique symbol` fallback: tsup emits `.d.ts` and `.d.cts` separately and
 * `unique symbol` is nominal, so the `require` and `import` clients would be
 * different types. `never` has no identity to disagree about.
 */
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
 * The `transaction` overload is what gives `await using trx = await
 * db.transaction()` a disposable transactor. Its parameter list mirrors knex's
 * `transaction(transactionScope?: null, config?)` deliberately: a bare
 * `transaction(): …` loses overload resolution to knex's own, whichever side of
 * the intersection it sits on — matching the arity is what wins, not ordering.
 * Every other call shape, the callback form included, falls through to `Knex`.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- mirrors knex's own public `Knex<TRecord, TResult>` signature (src/core/client.ts follows the same pattern).
export type DisposableKnex<TRecord extends {} = any, TResult = unknown[]> = {
  transaction(
    transactionScope?: null,
    config?: Knex.TransactionConfig,
  ): Promise<DisposableTransaction<TRecord, TResult>>
} & Knex<TRecord, TResult> &
  Record<AsyncDisposeKey, () => Promise<void>>
