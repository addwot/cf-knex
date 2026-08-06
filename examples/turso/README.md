# [cf-knex](../../README.md) + Turso (libsql)

> **A Worker querying hosted SQLite over HTTP — transactions included, unlike D1.**

- Entry point `cf-knex/turso` · driver [`@libsql/client`](https://www.npmjs.com/package/@libsql/client)
- Transactions ✓ · streaming ✗ — [what differs](#what-differs-on-turso)
- [Knex.js query-builder docs](https://knexjs.org/) · [all examples](..) · [package README](../../README.md)

Turso is hosted SQLite reached over HTTP, via `@libsql/client`. The same example
works against a self-hosted `libsql-server`: point `TURSO_URL` at it and drop the
auth token.

## Install

```sh
pnpm add cf-knex knex @libsql/client
# or
yarn add cf-knex knex @libsql/client
# or
npm install cf-knex knex @libsql/client
```

## Configure

```sh
npx wrangler secret put TURSO_AUTH_TOKEN   # from: turso db tokens create <database>
```

The URL is not a secret and lives in `wrangler.jsonc` under `vars`. The token is,
so it goes in as a secret — never in the committed config.

```jsonc
{
  "compatibility_flags": ["nodejs_compat"],
  "vars": { "TURSO_URL": "libsql://<database>-<org>.turso.io" }
}
```

## Schema

Migrations cannot run inside a Worker. Apply them with the Turso CLI:

```sh
turso db shell <database> \
  "CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL)"
```

## Use

```ts
import { createClient } from 'cf-knex/turso'

const db = createClient({ url: env.TURSO_URL, authToken: env.TURSO_AUTH_TOKEN })
const [id] = await db('posts').insert({ title: 'hello' })
await db.destroy()
```

See [`src/index.ts`](src/index.ts) for the complete Worker.

## What differs on Turso

| | |
|---|---|
| **Transactions** | Fully supported, including savepoints for nested transactions. This is the main practical difference from D1. |
| **Streaming** | Not available. `.stream()` throws `UNSUPPORTED_CAPABILITY` — use `.limit()`/`.offset()`. |
| **Large integers** | SQLite INTEGERs come back as JS numbers by default, losing precision above 2^53. Pass `intMode: 'bigint'` when a column can exceed that. |
| **Migrations** | Run them from the Turso CLI, never from inside the Worker. |

## Deploy

```sh
npx wrangler deploy
```
