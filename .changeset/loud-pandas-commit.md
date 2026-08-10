---
'cf-knex': patch
---

Fix `await trx.commit()` resolving as though the commit succeeded when it
actually failed.

Affects the transactor form only — `const trx = await db.transaction()`, with or
without `await using` — where knex assigns a failed COMMIT's error to the
transaction's own promise and resolves the one `commit()` returned anyway,
leaving nothing to observe it. `db.transaction(async trx => …)` was never
affected.

Worst case is silent data loss on postgres: a transaction postgres has already
aborted executes its COMMIT as a ROLLBACK, the pg adapter raises
`COMMIT_SILENTLY_ROLLED_BACK` to report that the work is gone, and that error
never reached the caller. `await trx.commit()` now rejects with it — the adapter's
own error object, so `err instanceof CfKnexError` and `err.code` both hold. Not
postgres-specific: a connection dropped mid-COMMIT was discarded the same way on
every adapter.

A healthy commit still resolves, and a query error the caller already handled
does not make a later good commit reject.
