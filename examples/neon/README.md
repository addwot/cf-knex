# [cf-knex](../../README.md) + Neon

> **A Worker querying Neon — the `pg` adapter, plus the endpoint choice Neon forces on
> you.**

- Entry point `cf-knex/postgres` · driver [`pg`](https://www.npmjs.com/package/pg)
- Transactions ✓ · streaming ✓ — [what differs](#what-differs-on-neon)
- [Knex.js query-builder docs](https://knexjs.org/) · [examples and guide](../README.md) · [package README](../../README.md)

**Neon is Postgres.** There is no Neon adapter and no `cf-knex/neon` entry point —
you use `cf-knex/postgres` and the `pg` driver, exactly as in
[`../postgres`](../postgres). This example exists because Neon's two endpoint types
and its connection limits are worth calling out, not because the code differs.

## Install

```sh
pnpm add cf-knex knex pg
# or
yarn add cf-knex knex pg
# or
npm install cf-knex knex pg
```

## Configure

The connection string contains the password, so it is a secret:

```sh
npx wrangler secret put NEON_URL
```

Neon gives you two endpoints for the same database:

| Endpoint | Host | When to use it |
|---|---|---|
| **Pooled** | `...-pooler.<region>.aws.neon.tech` | Default choice from a Worker. PgBouncer sits in front, so short-lived connections are cheap. |
| **Direct** | `...<region>.aws.neon.tech` | Session-level features the pooler cannot proxy. Costs a full connect per request. |

Both work with cf-knex; both are covered by this project's live test suite.

## Through Hyperdrive instead

`src/index.ts` ships with both, one commented out. Hyperdrive works with Neon and
removes the per-request connect cost entirely:

```ts
const db = createClient({ hyperdrive: env.HYPERDRIVE })
```

Give Hyperdrive the **direct** (non-pooler) URL — it does its own pooling, so
stacking it on PgBouncer buys nothing. Uncomment the binding in `wrangler.jsonc`:

```jsonc
{ "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "..." }] }
```

## Use

```ts
import { createClient } from 'cf-knex/postgres'

const db = createClient({ url: env.NEON_URL })
const [row] = await db('posts').insert({ title: 'hello' }).returning('id')
```

See [`src/index.ts`](src/index.ts) for the complete Worker.

## What differs on Neon

| | |
|---|---|
| **Transactions** | Fully supported on both endpoints. |
| **Streaming** | Supported. |
| **Inserted ids** | Postgres has no `lastInsertId` — use `.returning('id')`. |
| **Cold starts** | A scale-to-zero Neon branch can take a second or two to wake. The first query after idle is slow, not broken. |
| **Migrations** | Run them from a plain Node Knex.js process, never from inside the Worker. |

## Deploy

```sh
npx wrangler deploy
```
