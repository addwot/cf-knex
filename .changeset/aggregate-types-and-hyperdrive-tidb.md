---
"cf-knex": patch
---

Document three things that were wrong or missing, all of them measured rather than inferred.

**Hyperdrive cannot front TiDB Cloud Serverless.** The README previously suggested reaching a Serverless cluster through Hyperdrive as the preferable option. Creating the configuration fails outright with `Hyperdrive does not currently support MySQL AuthSwitchRequest messages`, so the HTTP driver is not the better choice for that tier — it is the only one. TiDB Dedicated and self-hosted TiDB are unaffected and still work through Hyperdrive with `cf-knex/mysql`.

**Aggregate return types differ per backend, and the previous note only covered TiDB.** `count()` is a decimal string on `tidb-http` and `pg` but a number on `mysql2` and `libsql`; `sum()` and `avg()` are strings everywhere except libsql; `max()`/`min()` are numbers everywhere. The README now carries the full table, taken from running the same query against each backend. The trap is `mysql2` returning a number for `count()` and a string for `sum()`, so code written against MySQL breaks on `count` specifically when moved to TiDB Serverless or Postgres.

**Neon behind a real Hyperdrive binding is now a verified configuration**, not an assumed one. The existing suites use `localConnectionString`, which exercises the binding's shape while connecting straight to Docker. Running from a Worker against an actual Hyperdrive configuration confirmed DDL, `insert` with `returning`, committed and rolled-back transactions, row streaming and aggregates all behave as they do direct.

Prose now says "Knex.js" for the query builder throughout; lowercase `knex` in code font remains the package name.

Development-only: adds `pnpm bench:tidb`, which compares cf-knex against raw `@tidbcloud/serverless` on byte-identical SQL. Nothing about the published package changes.
