# cf-knex

## 0.3.1

### Patch Changes

- 200607a: Fix `await trx.commit()` resolving as though the commit succeeded when it
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

## 0.3.0

### Minor Changes

- 0d21615: Add `timeoutMs` and `fetch` to the TiDB Cloud Serverless HTTP driver.

  `@tidbcloud/serverless` calls `fetch` with no signal, no timeout and no retry, and cf-knex
  gave you no way to wrap it — so a request that stalled stalled forever, and a Worker
  waited until the platform killed it. Seen in practice: a statement that normally takes
  ~1s hung past 30s against an otherwise healthy cluster, while every other statement in
  the same run kept its usual timing.

  `timeoutMs` bounds each request and raises `CfKnexError` with the new `REQUEST_TIMEOUT`
  code. It is opt-in and has no default, because the abort is local: a statement that times
  out may still be applied server-side, so the error means unknown outcome, not "did not
  happen". The signal is both passed to `fetch` and raced, so the bound holds even for a
  `fetch` that ignores signals.

  `fetch` replaces the one handed to the driver, for retries, tracing, or a more specific
  bound. `timeoutMs` composes on top of it. Both are available on `cf-knex/tidb`'s
  `createClient` and on the root `createClient`'s `ClientConfig`. Nothing changes for a
  client that sets neither, which is handed the same unwrapped `fetch` as before.

### Patch Changes

- 7462f82: Serialise statements issued in parallel inside one TiDB Cloud Serverless transaction.

  A transaction is a single server-side session, and a session runs one statement at a
  time — `@tidbcloud/serverless` documents this, and parallel statements surfaced as
  `Rollback transaction fail: invalid connection`
  ([serverless-js#61](https://github.com/tidbcloud/serverless-js/issues/61), closed by its
  maintainers as "run the transaction serially"). Knex.js does not serialise them, so
  `await Promise.all([trx('a').insert(…), trx('b').insert(…)])` — ordinary code that works
  on every other backend cf-knex supports — could corrupt the session.

  The `tidb-http` adapter now queues in-transaction statements per handle, giving each
  transaction a concurrency of one. Statements outside a transaction are unaffected and
  stay parallel.

  This also makes the `TRANSACTION_ESCAPED` detector sound. It compares the session token
  left by a statement's own response, so a concurrent sibling could overwrite that token
  mid-check — letting it both miss a real escape and report one for a statement that never
  escaped.

## 0.2.0

### Minor Changes

- e8b6bfe: `destroy()` no longer hangs, and `await using` now works on the client and on a transactor.

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

## 0.1.2

### Patch Changes

- b0c136c: Document three things that were wrong or missing, all of them measured rather than inferred.

  **Hyperdrive cannot front TiDB Cloud Serverless.** The README previously suggested reaching a Serverless cluster through Hyperdrive as the preferable option. Creating the configuration fails outright with `Hyperdrive does not currently support MySQL AuthSwitchRequest messages`, so the HTTP driver is not the better choice for that tier — it is the only one. TiDB Dedicated and self-hosted TiDB are unaffected and still work through Hyperdrive with `cf-knex/mysql`.

  **Aggregate return types differ per backend, and the previous note only covered TiDB.** `count()` is a decimal string on `tidb-http` and `pg` but a number on `mysql2` and `libsql`; `sum()` and `avg()` are strings everywhere except libsql; `max()`/`min()` are numbers everywhere. The README now carries the full table, taken from running the same query against each backend. The trap is `mysql2` returning a number for `count()` and a string for `sum()`, so code written against MySQL breaks on `count` specifically when moved to TiDB Serverless or Postgres.

  **Neon behind a real Hyperdrive binding is now a verified configuration**, not an assumed one. The existing suites use `localConnectionString`, which exercises the binding's shape while connecting straight to Docker. Running from a Worker against an actual Hyperdrive configuration confirmed DDL, `insert` with `returning`, committed and rolled-back transactions, row streaming and aggregates all behave as they do direct.

  Prose now says "Knex.js" for the query builder throughout; lowercase `knex` in code font remains the package name.

  Development-only: adds `pnpm bench:tidb`, which compares cf-knex against raw `@tidbcloud/serverless` on byte-identical SQL. Nothing about the published package changes.

- b0c136c: Document that TiDB Cloud Serverless returns `COUNT` as a decimal string.

  Its HTTP driver encodes aggregate results as strings, so `count('* as count')` yields `'2'` where the same query over the MySQL wire protocol yields `2`. Verified live against both. The failure is quiet — `count > 10` compares strings and `count === 0` is never true — so it is now in the divergences section of the README alongside `insertId`, and pinned by a test rather than hidden behind the `Number()` coercion the conformance suite already used.

  Also adds join coverage for the TiDB HTTP adapter: aliased inner joins, `LEFT JOIN` producing `null` (not a missing key) for unmatched rows, joins inside a transaction seeing that transaction's own uncommitted rows and losing them on rollback, grouped counts over a join, and the fact that `select('*')` across a join silently collapses duplicate column names with the last table winning.

## 0.1.1

### Patch Changes

- c2e8dcf: Document that TiDB Cloud Serverless returns `COUNT` as a decimal string.

  Its HTTP driver encodes aggregate results as strings, so `count('* as count')` yields `'2'` where the same query over the MySQL wire protocol yields `2`. Verified live against both. The failure is quiet — `count > 10` compares strings and `count === 0` is never true — so it is now in the divergences section of the README alongside `insertId`, and pinned by a test rather than hidden behind the `Number()` coercion the conformance suite already used.

  Also adds join coverage for the TiDB HTTP adapter: aliased inner joins, `LEFT JOIN` producing `null` (not a missing key) for unmatched rows, joins inside a transaction seeing that transaction's own uncommitted rows and losing them on rollback, grouped counts over a join, and the fact that `select('*')` across a join silently collapses duplicate column names with the last table winning.

## 0.1.0

### Minor Changes

- 89aa6d4: Initial release: a Knex.js-syntax database connector for Cloudflare Workers, covering MySQL, TiDB, Postgres, D1 and Turso, direct or through Hyperdrive.

  `createClient()` returns a real Knex.js instance built on Knex.js's own dialect classes, so the query builder, `db.raw()`, transactions and savepoints behave as Knex.js documents them. Five backends sit behind one API, selected by `engine` or inferred from what you pass: MySQL and TiDB over the MySQL wire protocol (`mysql2`), Postgres including Neon (`pg`), TiDB Cloud Serverless over HTTP (`@tidbcloud/serverless`), Cloudflare D1, and Turso/libsql (`@libsql/client`). Each is also its own entry point — `cf-knex/mysql`, `cf-knex/postgres`, `cf-knex/tidb`, `cf-knex/d1`, `cf-knex/turso` — so a Worker bundles only the adapter it uses.

  Connect by URL, by a Hyperdrive binding, by a D1 binding, or by explicit credentials; `fromEnv()` picks whichever is present. Failures arrive as `CfKnexError` with a closed `code` union of eleven values, and connection URLs are redacted before they reach driver-inference error messages.

  Two Workers-specific behaviours are worth knowing before you start. Migrations cannot run inside a Worker: Knex.js's `browser` field replaces its `Migrator` with a no-op that a Workers bundler honours, and Knex.js's default migration source reads files off a filesystem Workers do not have. Streaming is available on mysql2 and pg only, and raises a typed error elsewhere. Both are covered in the README, along with the `mariadb/callback` resolution failure that makes stock Knex.js unbuildable for a Worker in the first place — the reason this package exists.

<!-- Changesets prepends each new version directly under the `# cf-knex`
     heading at the top of this file, so the oldest release sits here at the
     bottom. Do not hand-edit a released section to describe different work —
     add a changeset (`pnpm changeset`) and it becomes the entry for the next
     version. -->
