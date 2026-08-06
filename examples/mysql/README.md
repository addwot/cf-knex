# [cf-knex](../../README.md) + MySQL

> **A Worker querying MySQL 8 over the wire protocol, by URL or through a Hyperdrive
> binding.**

- Entry point `cf-knex/mysql` · driver [`mysql2`](https://www.npmjs.com/package/mysql2)
- Transactions ✓ · streaming ✓ — [what differs](#what-differs-on-mysql)
- [Knex.js query-builder docs](https://knexjs.org/) · [all examples](..) · [package README](../../README.md)

MySQL 8 over the wire protocol, via `mysql2` — connected either by URL or through
a Hyperdrive binding. MariaDB uses the same adapter; see
[`../mariadb`](../mariadb) for the differences that actually matter.

## Install

```sh
pnpm add cf-knex knex mysql2
# or
yarn add cf-knex knex mysql2
# or
npm install cf-knex knex mysql2
```

## Two ways to connect

`src/index.ts` ships with both, one commented out. Swap the line — nothing else
in the Worker changes.

**By URL** (the default). The connection string holds the password, so it is a
secret:

```sh
npx wrangler secret put MYSQL_URL
```

```ts
const db = createClient({ url: env.MYSQL_URL })
```

**Through Hyperdrive.** It pools connections at Cloudflare's edge and caches the
TLS handshake, and holds the credentials so the Worker never sees a password:

```sh
npx wrangler hyperdrive create cf-knex-example-mysql \
  --connection-string="mysql://<user>:<password>@<host>:3306/<database>"
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

For local `wrangler dev`:

```sh
export WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="mysql://root:root@127.0.0.1:3306/database"
```

**By explicit credentials**, if you prefer them to a URL:

```ts
const db = createClient({ connection: { host, port, user, password, database, ssl: true } })
```

## Use

```ts
import { createClient } from 'cf-knex/mysql'

const db = createClient({ url: env.MYSQL_URL })
// or: createClient({ hyperdrive: env.HYPERDRIVE })
const [id] = await db('posts').insert({ title: 'hello' })
await db.destroy()
```

See [`src/index.ts`](src/index.ts) for the complete Worker.

## What differs on MySQL

| | |
|---|---|
| **Transactions** | Fully supported, including savepoints and isolation levels. |
| **Streaming** | Supported. `.stream()` works, backed by mysql2's row stream. |
| **Inserted ids** | `insert()` resolves to the auto-increment value — no `.returning()` needed. |
| **`disableEval`** | cf-knex forces mysql2's `disableEval: true` on every connection. mysql2 compiles its row parsers with `eval` by default, which Workers forbid. This is not configurable, and nothing works without it. |
| **Migrations** | Run them from a plain Node Knex.js process, never from inside the Worker. |

## Deploy

```sh
npx wrangler deploy
```
