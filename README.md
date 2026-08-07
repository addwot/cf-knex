# [cf-knex](https://www.npmjs.com/package/cf-knex)

[![npm version](https://img.shields.io/npm/v/cf-knex.svg)](https://npmjs.org/package/cf-knex)
[![CI](https://github.com/addwot/cf-knex/actions/workflows/ci.yml/badge.svg)](https://github.com/addwot/cf-knex/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/cf-knex.svg)](LICENSE)

> **Knex.js query-builder syntax on Cloudflare Workers — _no TCP required_.**

A multi-backend (TiDB Cloud Serverless, MySQL, MariaDB, Postgres, Neon, Cloudflare D1,
Turso) connector for Workers, connected directly or through Hyperdrive, featuring:

- transactions on every backend but D1
- row streaming on MySQL and Postgres
- Hyperdrive and D1 bindings passed straight through, or found for you by `fromEnv`
- one entry point per backend, 3.3–3.9 kB brotli, so a Worker bundles a single adapter
- typed errors where a backend cannot do what was asked, never a generic driver crash
- a conformance suite run against every backend, hosted tiers included

Knex.js 3 (`^3.1.0`) is a peer dependency and does the real work: the query builder,
schema builder and transactions are Knex.js's own.

- Take a look at the [full guide](examples/README.md) to get started
- Browse a runnable Worker per database in [`examples/`](examples/)
- Read [things that will surprise you](examples/README.md#things-that-will-surprise-you)
  before you ship — the backends disagree, and every entry there is measured
- Query-builder documentation is Knex.js's own, and all of it applies: [knexjs.org](https://knexjs.org/)
- For an error code you do not recognise, see [Errors](examples/README.md#errors)
- In case you are wondering why a wrapper is needed at all, see
  [Why this exists](examples/README.md#why-this-exists) — stock Knex.js does not build for
  a Worker

You can report bugs and request features on the
[GitHub issues page](https://github.com/addwot/cf-knex/issues).
[CONTRIBUTING.md](CONTRIBUTING.md) covers pull requests, [CHANGELOG.md](CHANGELOG.md) the
releases.

## Install

```sh
pnpm add cf-knex knex
# or
yarn add cf-knex knex
# or
npm install cf-knex knex
```

Then the driver for the backend you use — an optional peer dependency, one entry point
each. You only need the one you actually connect with.

| Import | Backend | Driver to install | Transactions | Streaming |
|---|---|---|---|---|
| `cf-knex/tidb` | ⚡ TiDB Cloud Serverless (HTTP) | `@tidbcloud/serverless` | ✅ | ❌ |
| `cf-knex/mysql` | 🐬 MySQL / MariaDB / TiDB Dedicated or self-hosted | `mysql2` | ✅ | ✅ |
| `cf-knex/postgres` | 🐘 Postgres / Neon | `pg` | ✅ | ✅ |
| `cf-knex/turso` | 🪶 Turso / libsql | `@libsql/client` | ✅ | ❌ |
| `cf-knex/d1` | 🟠 Cloudflare D1 | *none — the binding is the driver* | ❌ | ❌ |

Your `wrangler.jsonc` needs Node compatibility — Knex.js itself uses `events` and
`timers`:

```jsonc
{
  "compatibility_flags": ["nodejs_compat"]
}
```

## Example

A complete Worker.

```ts
import { createClient } from 'cf-knex/tidb'

export default {
  async fetch(req: Request, env: { TIDB_URL: string }) {
    const db = createClient({ url: env.TIDB_URL })
    const users = await db('users').where('active', true).select('id', 'email')
    return Response.json(users)
  },
}
```

No teardown call, because after ordinary queries there is nothing to tear down on any
backend — that is measured, per backend, in [Lifetime](examples/README.md#lifetime).
`db.destroy()` is still there when you want it, and `await using db = createClient(…)`
calls it for you. What *does* need finishing is a transaction: use
`db.transaction(async trx => { … })`, which commits for you, or
`await using trx = await db.transaction()`, which rolls back unless you call `commit()`
yourself.

Every other backend is the same Worker with a different import and a different connection
field — a binding for D1, `hyperdrive` for anything behind Hyperdrive, `url` plus
`authToken` for Turso. [`examples/`](examples/) has each of them as a project you can run,
and the guide covers [connecting](examples/README.md#connecting) in full.

## TypeScript example

The row type goes on the table call, as in stock Knex.js, and `.select()` narrows it to
the columns you asked for:

```ts
type User = { id: number; email: string; active: boolean }

const db = createClient({ url: env.TIDB_URL })
const rows = await db<User>('users').where('active', true).select('id', 'email')
//    ^? Pick<User, 'id' | 'email'>[]
```

`createClient<T>` accepts Knex.js's `TRecord` generic too, but that sets the default row
type for *every* table at once, so the per-call form above is usually what you want.

## Development

```sh
pnpm install
docker compose up -d      # mysql, mariadb, postgres, libsql
pnpm test                 # unit (workerd) + integration (node) + types
pnpm lint && pnpm typecheck
pnpm verify:bundle        # packs the tarball and builds it with real wrangler
```

Hosted-tier suites are skipped unless their environment variables are set; a skipped
suite says which variable was missing rather than passing quietly.
[CONTRIBUTING.md](CONTRIBUTING.md) covers which directory a test belongs in and why, when
a changeset is needed, and what CI does and does not check on a pull request.

## License

MIT
