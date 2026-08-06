# cf-knex + Cloudflare D1

D1 is Cloudflare's own SQLite database. It is reached through a **binding**, not a
connection string, so there are no credentials in this example at all.

## Install

```sh
pnpm add cf-knex knex
# or
yarn add cf-knex knex
# or
npm install cf-knex knex
```

No driver package. The D1 binding *is* the driver — this is the only backend
cf-knex supports with no optional peer dependency.

## Configure

Create the database and copy the id wrangler prints into `wrangler.jsonc`:

```sh
npx wrangler d1 create cf-knex-example
```

```jsonc
{
  "compatibility_flags": ["nodejs_compat"],
  "d1_databases": [{ "binding": "DB", "database_name": "cf-knex-example", "database_id": "..." }]
}
```

`nodejs_compat` is not optional — Knex.js imports `events` and `timers`.

## Schema

Migrations cannot run inside a Worker (see below), so apply them with wrangler:

```sh
npx wrangler d1 execute cf-knex-example --command \
  "CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL)"
```

## Use

```ts
import { createClient } from 'cf-knex/d1'

const db = createClient({ binding: env.DB })
const posts = await db('posts').orderBy('id', 'desc').limit(10)
await db.destroy()
```

See [`src/index.ts`](src/index.ts) for the complete Worker.

## What differs on D1

| | |
|---|---|
| **Transactions** | Not available. D1 has no interactive transactions; `db.transaction()` throws `UNSUPPORTED_CAPABILITY`. Use `batch()` on the raw binding when you need atomicity. |
| **Streaming** | Not available. `.stream()` throws `UNSUPPORTED_CAPABILITY` — use `.limit()`/`.offset()`. |
| **Migrations** | Run them with `wrangler d1 migrations`, never from inside the Worker. |
| **`Date` bindings** | Not supported by the binding itself — it throws `D1_TYPE_ERROR`. Convert to an ISO string or epoch number before inserting. |

## Deploy

```sh
npx wrangler deploy
```
