---
"cf-knex": minor
---

Initial release: a knex-syntax database connector for Cloudflare Workers, covering MySQL, TiDB, Postgres, D1 and Turso, direct or through Hyperdrive.

`createClient()` returns a real knex instance built on knex's own dialect classes, so the query builder, `db.raw()`, transactions and savepoints behave as knex documents them. Five backends sit behind one API, selected by `engine` or inferred from what you pass: MySQL and TiDB over the MySQL wire protocol (`mysql2`), Postgres including Neon (`pg`), TiDB Cloud Serverless over HTTP (`@tidbcloud/serverless`), Cloudflare D1, and Turso/libsql (`@libsql/client`). Each is also its own entry point — `cf-knex/mysql`, `cf-knex/postgres`, `cf-knex/tidb`, `cf-knex/d1`, `cf-knex/turso` — so a Worker bundles only the adapter it uses.

Connect by URL, by a Hyperdrive binding, by a D1 binding, or by explicit credentials; `fromEnv()` picks whichever is present. Failures arrive as `CfKnexError` with a closed `code` union of eleven values, and connection URLs are redacted before they reach driver-inference error messages.

Two Workers-specific behaviours are worth knowing before you start. Migrations cannot run inside a Worker: knex's `browser` field replaces its `Migrator` with a no-op that a Workers bundler honours, and knex's default migration source reads files off a filesystem Workers do not have. Streaming is available on mysql2 and pg only, and raises a typed error elsewhere. Both are covered in the README, along with the `mariadb/callback` resolution failure that makes stock knex unbuildable for a Worker in the first place — the reason this package exists.
