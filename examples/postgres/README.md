# [cf-knex](../../README.md) + Postgres

> **A Worker querying Postgres, by URL or through a Hyperdrive binding.**

- Entry point `cf-knex/postgres` · driver [`pg`](https://www.npmjs.com/package/pg)
- Transactions ✓ · streaming ✓ — [what differs](#what-differs-on-postgres)
- [Knex.js query-builder docs](https://knexjs.org/) · [examples and guide](../README.md) · [package README](../../README.md)

Plain Postgres — self-hosted, RDS, Cloud SQL, anything speaking the wire protocol —
connected either by URL or through a Hyperdrive binding. For Neon specifically see
[`../neon`](../neon), which is the same `pg` adapter with hosted-provider notes.

## Install

```sh
pnpm add cf-knex knex pg
# or
yarn add cf-knex knex pg
# or
npm install cf-knex knex pg
```

## Two ways to connect

`src/index.ts` ships with both, one commented out. Swap the line — nothing else
in the Worker changes.

**By URL** (the default). The connection string holds the password, so it is a
secret:

```sh
npx wrangler secret put POSTGRES_URL
```

```ts
const db = createClient({ url: env.POSTGRES_URL })
```

**Through Hyperdrive.** Hyperdrive pools connections at Cloudflare's edge and
caches the TLS handshake, so a request does not pay a full connect. It also holds
the credentials, so the Worker never sees a password:

```sh
npx wrangler hyperdrive create cf-knex-example \
  --connection-string="postgres://<user>:<password>@<host>:5432/<database>"
```

Uncomment the binding in `wrangler.jsonc` with the id it prints:

```jsonc
{
  "compatibility_flags": ["nodejs_compat"],
  "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "..." }]
}
```

```ts
const db = createClient({ hyperdrive: env.HYPERDRIVE })
```

For local `wrangler dev` against a local database:

```sh
export WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="postgres://postgres:postgres@127.0.0.1:5432/postgres"
```

**By explicit credentials**, if you prefer them to a URL:

```ts
const db = createClient({ connection: { host, port, user, password, database, ssl: true } })
```

## Use

```ts
import { createClient } from 'cf-knex/postgres'

const db = createClient({ url: env.POSTGRES_URL })
// or: createClient({ hyperdrive: env.HYPERDRIVE })
const [row] = await db('posts').insert({ title: 'hello' }).returning('id')
await db.destroy()
```

See [`src/index.ts`](src/index.ts) for the complete Worker.

## What differs on Postgres

| | |
|---|---|
| **Transactions** | Fully supported, including savepoints and isolation levels. |
| **Streaming** | Supported. `.stream()` works, backed by a real cursor. |
| **Inserted ids** | Postgres has no `lastInsertId` — use `.returning('id')`. |
| **Migrations** | Run them from a plain Node Knex.js process against the database, never from inside the Worker. |

## Deploy

```sh
npx wrangler deploy
```
