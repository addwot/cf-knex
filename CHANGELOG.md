# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — Unreleased

First release.

### Added

- `createClient()` from `cf-knex`, returning a real knex instance built on
  knex's own dialect classes. The query builder, `db.raw()`, transactions and
  savepoints behave as knex documents them. Streaming works on the drivers
  that support it — mysql2 and pg — and raises a typed error on the ones that
  do not; see the capabilities matrix in the README.
- Five backends behind one API, selected by `engine` or inferred from the
  connection you pass: MySQL and TiDB over MySQL wire protocol (`mysql2`),
  Postgres including Neon (`pg`), TiDB Cloud Serverless over HTTP
  (`@tidbcloud/serverless`), Cloudflare D1, and Turso/libsql
  (`@libsql/client`).
- Each backend also available as its own entry point — `cf-knex/mysql`,
  `cf-knex/postgres`, `cf-knex/tidb`, `cf-knex/d1`, `cf-knex/turso` — so a
  Worker bundles only the adapter it uses.
- Connect by URL, by a Hyperdrive binding, by a D1 binding, or by explicit
  credentials. `fromEnv()` picks whichever of those is present.
- Typed failures via `CfKnexError`, with a closed `code` union of ten values
  documented in the README.
- Connection URLs are redacted before they appear in driver-inference error
  messages.

### Notes

- Stock knex does not build for a Worker: `mariadb/callback` escapes knex's
  `browser` field and esbuild fails to resolve it. Avoiding that is the
  reason this package constructs its client through
  `knex/lib/knex-builder/make-knex.js` rather than knex's main entry.
- `disableEval: true` is forced on every mysql2 connection. Workers forbid
  dynamic code generation, and without it every row-returning query fails.
- Migrations do not run inside a Worker. knex's `browser` field replaces its
  `Migrator` and `Seeder` with no-ops, which a Workers bundler honours, and
  knex's default migration source reads files off a filesystem Workers do not
  have. Run migrations from your own tooling against the database instead.
- Every published entry point is checked on each push by packing the real
  tarball, installing it into a throwaway project, and running a genuine
  `wrangler deploy --dry-run` against it.
