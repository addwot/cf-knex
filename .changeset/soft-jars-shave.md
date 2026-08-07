---
'cf-knex': minor
---

`destroy()` no longer hangs, and `await using` now works on the client and on a transactor.

- **`destroy()` is bounded.** It used to wait forever whenever a connection was still
  checked out — usually a transaction from `const trx = await db.transaction()` that was
  never committed or rolled back. It now waits up to 6 seconds for the pool, then the same
  for the adapter, warns which case it hit, and returns. Nothing is force-closed, so a slow
  but progressing teardown still completes normally.
- **`destroy()` is idempotent.** Repeat and concurrent calls share one teardown, and calling
  it on a transactor no longer tears down the pool its transaction is still using.
- **New `knex.destroyTimeoutMs` option** to change that budget. It is the cost of
  `destroy()` as a whole, not per internal step: teardown waits on the pool and then on the
  adapter, and the adapter gets whatever the pool left.
- **`await using db = createClient(…)`** calls `destroy()` at scope exit.
- **`await using trx = await db.transaction()`** rolls back on any path that did not commit,
  including a throw, and does nothing if the transaction already finished. This is the shape
  that matters on TiDB Cloud Serverless and Turso, where an abandoned transaction holds locks
  server-side until the backend expires them.
- **New exported types `DisposableKnex` and `DisposableTransaction`**, from the barrel and
  every per-database entry point. `createClient` and `fromEnv` now return `DisposableKnex` —
  `Knex` plus the disposer, so existing code keeps compiling.

Docs now state per backend what actually needs cleaning up, which is measured: after ordinary
queries, nothing does, on any of the five. The README and example Workers no longer wrap
`db.destroy()` in `try`/`finally`.
