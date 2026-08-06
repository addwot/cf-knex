# cf-knex + MariaDB

MariaDB speaks the MySQL wire protocol, so it uses the **`mysql2` driver and the
`cf-knex/mysql` entry point** — same code as [`../mysql`](../mysql).

## Do not install the `mariadb` package

This is the one thing worth knowing, and it is the reason cf-knex exists.

knex declares `mariadb` among its dialect drivers. Its `package.json` `browser`
field maps bare driver names to `false` so a bundler can drop them — but a bare key
does not cover subpaths, and knex imports `mariadb/callback`. That subpath escapes
the substitution, so a Worker build fails to resolve it and **stock knex cannot be
bundled for Workers at all**.

cf-knex never routes MariaDB through that dialect. It uses `mysql2`, which MariaDB
serves correctly, and the import never appears.

```sh
npm install cf-knex knex mysql2
# or
pnpm add cf-knex knex mysql2
# or
yarn add cf-knex knex mysql2
```

## Two ways to connect

`src/index.ts` ships with both, one commented out. Swap the line — nothing else
in the Worker changes.

**By URL** (the default). The connection string holds the password, so it is a
secret:

```sh
npx wrangler secret put MARIADB_URL
```

Note the `mysql://` scheme — Hyperdrive and cf-knex both identify MariaDB by the
protocol it speaks, not by the product name.

**Through Hyperdrive.** It pools connections at Cloudflare's edge and holds the
credentials, so the Worker never sees a password:

```sh
npx wrangler hyperdrive create cf-knex-example-mariadb \
  --connection-string="mysql://<user>:<password>@<host>:3306/<database>"
```

Uncomment the binding in `wrangler.jsonc` with the id it prints:

```jsonc
{
  "compatibility_flags": ["nodejs_compat"],
  "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "..." }]
}
```

## Use

```ts
import { createClient } from 'cf-knex/mysql'

const db = createClient({ url: env.MARIADB_URL })
// or: createClient({ hyperdrive: env.HYPERDRIVE })
const [id] = await db('posts').insert({ title: 'hello' })
await db.destroy()
```

See [`src/index.ts`](src/index.ts) for the complete Worker.

## What differs on MariaDB

| | |
|---|---|
| **Driver** | `mysql2`, never `mariadb`. See above. |
| **Transactions** | Fully supported, including savepoints and isolation levels. |
| **Streaming** | Supported. |
| **Inserted ids** | `insert()` resolves to the auto-increment value. |
| **Migrations** | Run them from a plain Node knex process, never from inside the Worker. |

MariaDB 11 runs the full conformance suite in this project's CI, alongside MySQL 8.

## Deploy

```sh
npx wrangler deploy
```
