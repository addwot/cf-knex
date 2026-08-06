# cf-knex + TiDB Cloud Serverless

TiDB can be reached two ways from a Worker, and they are genuinely different
backends in cf-knex. Only TiDB Cloud Serverless offers the first one; self-hosted
TiDB and TiDB Dedicated speak the MySQL wire protocol and nothing else.

| | Entry point | Driver | Transport |
|---|---|---|---|
| **Serverless HTTP** (this example) | `cf-knex/tidb` | `@tidbcloud/serverless` | HTTPS, one request per statement |
| **Wire protocol** | `cf-knex/mysql` | `mysql2` | TCP, ideally through Hyperdrive |

Use the HTTP driver on TiDB Cloud Serverless: there is no socket to keep alive and
no Hyperdrive config to create. Use the wire protocol for TiDB Dedicated or a
self-hosted cluster — then follow [`../mysql`](../mysql) instead, unchanged.

## Install

```sh
pnpm add cf-knex knex @tidbcloud/serverless
# or
yarn add cf-knex knex @tidbcloud/serverless
# or
npm install cf-knex knex @tidbcloud/serverless
```

## Configure

The URL contains the password, so it is a secret:

```sh
npx wrangler secret put TIDB_URL
```

Take the serverless HTTP endpoint from the TiDB Cloud console — it looks like
`mysql://<user>:<password>@<host>.tidbcloud.com:4000/<database>`.

```jsonc
{
  "compatibility_flags": ["nodejs_compat"]
}
```

## Use

```ts
import { createClient } from 'cf-knex/tidb'

const db = createClient({ url: env.TIDB_URL })
const posts = await db('posts').orderBy('id', 'desc').limit(10)
await db.destroy()
```

See [`src/index.ts`](src/index.ts) for the complete Worker.

## What differs on TiDB over HTTP

| | |
|---|---|
| **Transactions** | Supported, including nested transactions via savepoints. |
| **Streaming** | Not available. `.stream()` throws `UNSUPPORTED_CAPABILITY` — use `.limit()`/`.offset()`. |
| **Inserted ids** | `insert()` resolves to a **bigint**, because the HTTP protocol returns `lastInsertId` as a decimal string. The same insert over `mysql2` gives a number. `JSON.stringify` throws on bigint — convert with `String(id)` before returning it. |
| **Isolation levels** | `serializable` is rejected with `UNSUPPORTED_TRANSACTION_MODE` rather than silently downgraded. `readOnly: true` is rejected for the same reason. |
| **Migrations** | Run them from a plain Node knex process, never from inside the Worker. |

## Deploy

```sh
npx wrangler deploy
```
