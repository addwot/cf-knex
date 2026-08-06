# [cf-knex](../README.md) examples

> **One directory per database, each a complete Cloudflare Worker you can `wrangler dev`
> as-is.**

- Each has its own `package.json`, `wrangler.jsonc`, `src/index.ts` and README
- [Knex.js query-builder docs](https://knexjs.org/) · [package README](../README.md) · [CONTRIBUTING](../CONTRIBUTING.md)

These are reference material, not a workspace: they are not part of the repo's
build, they are not published to npm, and they install `cf-knex` from the registry
like any consumer would. Their TypeScript **is** checked against the real API on
every CI run (`pnpm check:examples`), so a snippet here cannot silently drift out
of date.

| Example | Entry point | Driver | Transactions | Streaming |
|---|---|---|---|---|
| [`d1`](d1) | `cf-knex/d1` | *none — the binding is the driver* | ✗ | ✗ |
| [`turso`](turso) | `cf-knex/turso` | `@libsql/client` | ✓ | ✗ |
| [`postgres`](postgres) | `cf-knex/postgres` | `pg` | ✓ | ✓ |
| [`neon`](neon) | `cf-knex/postgres` | `pg` | ✓ | ✓ |
| [`mysql`](mysql) | `cf-knex/mysql` | `mysql2` | ✓ | ✓ |
| [`mariadb`](mariadb) | `cf-knex/mysql` | `mysql2` | ✓ | ✓ |
| [`tidb`](tidb) | `cf-knex/tidb` | `@tidbcloud/serverless` | ✓ | ✗ |

Two of these are the same backend as a neighbour, deliberately:

- **`neon`** is Postgres. There is no Neon adapter — it is the `pg` driver, and the
  example exists to cover the pooled/direct endpoint choice.
- **`mariadb`** is the MySQL wire protocol. It uses `mysql2`, never the `mariadb`
  package, and the example exists to explain why that matters for Workers.

## Running one

```sh
cd examples/postgres
pnpm install       # or: yarn install / npm install
npx wrangler dev
```

Each README lists the bindings or secrets that example needs first.

## Two things that apply to all of them

**`nodejs_compat` is required.** Knex.js imports `events` and `timers`. Every
`wrangler.jsonc` here sets it.

**Migrations cannot run inside a Worker.** Knex.js's `browser` field replaces its
`Migrator` with a no-op, and Workers have no filesystem for the default migration
source to read. Run migrations from your own tooling — `wrangler d1 migrations`,
the Turso CLI, or a plain Node Knex.js process. Reaching for `db.migrate` inside a
Worker throws a typed `UNSUPPORTED_CAPABILITY` error explaining this.
