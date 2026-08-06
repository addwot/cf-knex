# cf-knex

Knex query-builder syntax on Cloudflare Workers — MySQL, TiDB, Postgres, D1 and Turso,
connected directly or through Hyperdrive.

```ts
import { createClient } from 'cf-knex/d1'

export default {
  async fetch(req: Request, env: { DB: D1Database }) {
    const db = createClient({ binding: env.DB })
    const users = await db('users').where('active', true).select('id', 'email')
    return Response.json(users)
  },
}
```

## Why this exists

Stock knex does not build for a Worker. `import Knex from 'knex'` reaches
`knex/lib/dialects/index.js`, a frozen map of literal `require()` calls for all twelve
dialects. They are lazy at runtime, but a Workers bundler resolves them at build time,
and knex's `browser` field neutralises only the *bare* specifiers — the mariadb dialect
asks for the subpath `mariadb/callback`, which escapes, so the build fails with:

```
✘ [ERROR] Could not resolve "mariadb/callback"
```

cf-knex never imports knex's main entry. It builds on knex's dialect classes directly and
supplies its own connection layer, so every entry point bundles under a real
`wrangler deploy` with no `alias` entries in your `wrangler.jsonc`. That claim is a CI
gate, not a promise: every push packs the published tarball, installs it into a throwaway
project with real wrangler, and runs `wrangler deploy --dry-run` for all six entry points.

You still get knex — the query builder, schema builder, and transactions are knex's own.

## Install

```sh
npm install cf-knex knex
```

Then add the driver for the backend you use. Each is an optional peer dependency; you
only need the one you actually connect with.

| Backend | Package |
|---|---|
| D1 | *none* — the binding is the driver |
| Turso / libsql | `@libsql/client` |
| TiDB Serverless (HTTP) | `@tidbcloud/serverless` |
| MySQL / MariaDB / TiDB (wire protocol) | `mysql2` |
| Postgres / Neon | `pg` |

Your `wrangler.jsonc` needs Node compatibility — knex itself uses `events` and `timers`:

```jsonc
{
  "compatibility_flags": ["nodejs_compat"]
}
```

## Two ways to import

**Per-backend entry** — smallest bundle, narrowest options type:

```ts
import { createClient } from 'cf-knex/postgres'

const db = createClient({ hyperdrive: env.HYPERDRIVE })
```

**Root entry** — pick the backend at runtime with `engine`:

```ts
import { createClient } from 'cf-knex'

const db = createClient({ engine: 'postgres', hyperdrive: env.HYPERDRIVE })
```

Both return a real `Knex` instance. The per-backend entries pull in only their own
adapter; importing `cf-knex/d1` does not bundle the Postgres or MySQL code.

## Examples

Each block is a complete Worker. `db.destroy()` at the end of the request is deliberate —
see [Lifetime](#lifetime).

### D1

```ts
import { createClient } from 'cf-knex/d1'

export default {
  async fetch(req: Request, env: { DB: D1Database }) {
    const db = createClient({ binding: env.DB })
    try {
      return Response.json(await db('posts').orderBy('id', 'desc').limit(10))
    } finally {
      await db.destroy()
    }
  },
}
```

### Turso (libsql)

```ts
import { createClient } from 'cf-knex/turso'

export default {
  async fetch(req: Request, env: { TURSO_URL: string; TURSO_AUTH_TOKEN: string }) {
    const db = createClient({ url: env.TURSO_URL, authToken: env.TURSO_AUTH_TOKEN })
    try {
      const [id] = await db('posts').insert({ title: 'hello' })
      return Response.json({ id })
    } finally {
      await db.destroy()
    }
  },
}
```

### Postgres through Hyperdrive

```ts
import { createClient } from 'cf-knex/postgres'

export default {
  async fetch(req: Request, env: { HYPERDRIVE: Hyperdrive }) {
    const db = createClient({ hyperdrive: env.HYPERDRIVE })
    try {
      // Postgres has no insertId — ask for it with .returning(), as with stock knex.
      const [row] = await db('posts').insert({ title: 'hello' }).returning('id')
      return Response.json(row)
    } finally {
      await db.destroy()
    }
  },
}
```

### MySQL through Hyperdrive

```ts
import { createClient } from 'cf-knex/mysql'

export default {
  async fetch(req: Request, env: { HYPERDRIVE: Hyperdrive }) {
    const db = createClient({ hyperdrive: env.HYPERDRIVE })
    try {
      await db.transaction(async (trx) => {
        await trx('accounts').where('id', 1).decrement('balance', 100)
        await trx('accounts').where('id', 2).increment('balance', 100)
      })
      return new Response('ok')
    } finally {
      await db.destroy()
    }
  },
}
```

### TiDB Serverless over HTTP

No Hyperdrive and no TCP — this driver speaks TiDB Cloud's HTTP API, so it works from a
Worker with nothing in front of it.

```ts
import { createClient } from 'cf-knex/tidb'

export default {
  async fetch(req: Request, env: { TIDB_URL: string }) {
    const db = createClient({ url: env.TIDB_URL })
    try {
      return Response.json(await db('posts').count('* as n').first())
    } finally {
      await db.destroy()
    }
  },
}
```

### Credentials instead of a URL

Any backend that takes a `url` also takes a `connection` object:

```ts
import { createClient } from 'cf-knex'

const db = createClient({
  engine: 'mysql',
  connection: {
    host: env.DB_HOST,
    port: 3306,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    ssl: true,
  },
})
```

### Zero-config from bindings

`fromEnv` scans `env` for exactly one D1 or Hyperdrive binding and builds the matching
client. It throws `AMBIGUOUS_CONNECTION` if there is more than one and you did not pass
`prefer`.

```ts
import { fromEnv } from 'cf-knex'

export default {
  async fetch(req: Request, env: Env) {
    const db = fromEnv(env)
    try {
      return Response.json(await db('posts').select('*'))
    } finally {
      await db.destroy()
    }
  },
}
```

## Configuration

```ts
type ClientConfig = {
  engine: 'mysql' | 'postgres' | 'sqlite'
  driver?: 'mysql2' | 'tidb-http' | 'pg' | 'd1' | 'libsql'
  url?: string
  authToken?: string          // libsql/Turso
  connection?: Credentials
  hyperdrive?: Hyperdrive     // the binding, passed straight through
  binding?: D1Database
  knex?: Record<string, unknown>  // merged into the knex config (pool, log, …)
}
```

Exactly one of `url`, `connection`, `hyperdrive` and `binding` may be present; two or more
is `AMBIGUOUS_CONNECTION` rather than a silent precedence rule.

### Driver inference

`driver` is optional. When omitted it is inferred, then checked against `engine`:

| Config | Inferred driver |
|---|---|
| `binding` with a `prepare` method | `d1` |
| `hyperdrive` or `connection` | `pg` if `engine: 'postgres'`, else `mysql2` |
| `authToken` present | `libsql` |
| `libsql://` URL | `libsql` |
| host ends in `.tidbcloud.com` | `tidb-http` |
| `mysql://` URL | `mysql2` |
| `postgres://` / `postgresql://` URL | `pg` |

The `.tidbcloud.com` rule is a host-suffix match, so a `mysql://…tidbcloud.com/…` URL
infers `tidb-http`, not `mysql2`. If you want the wire protocol against TiDB Cloud —
through Hyperdrive, say — set `driver: 'mysql2'` explicitly.

## Capabilities

| Driver | Engine | Transactions | Streaming |
|---|---|---|---|
| `mysql2` | mysql | yes | yes |
| `pg` | postgres | yes | yes |
| `tidb-http` | mysql | yes | no |
| `libsql` | sqlite | yes | no |
| `d1` | sqlite | no | no |

Calling an unsupported capability throws `CfKnexError` with code
`UNSUPPORTED_CAPABILITY` and a message naming the alternative — never a generic driver
crash. For D1 that alternative is the binding's own `batch()`, which submits several
statements as one atomic unit.

## Things that will surprise you

These are measured behaviours, not theory. Each one is covered by a test.

**Migrations and seeds do not run inside a Worker.** knex's `package.json` maps its
`Migrator` and `Seeder` modules to a no-op through the `browser` field, and Workers
bundlers honour that, so `db.migrate.latest()` throws
`TypeError: Migrator is not a constructor` at runtime. This is knex's own packaging, not
something cf-knex can override from library code. Run migrations from Node or CI against
the same database — with stock knex, or `wrangler d1 migrations apply` for D1. Schema
building at runtime (`db.schema.createTable(…)`) works fine on every backend.

**`insertId` may be a `bigint`.** TiDB `AUTO_RANDOM`, 64-bit auto-increment columns and
libsql's `lastInsertRowid` all exceed 2^53, so cf-knex does not narrow them to `number`
and lose precision. Wrap it — `Number(id)` — rather than assuming either type.

**Large integer *columns* need `intMode` on Turso/libsql.** The libsql driver defaults to
`intMode: 'number'`, and decoding a column value above `Number.MAX_SAFE_INTEGER` under
that mode throws a bare `RangeError` from the driver, not a `CfKnexError`. cf-knex keeps
the driver's own default rather than making every ordinary integer a `bigint` for
everyone. If your schema has integer columns that can exceed 2^53, pass
`createClient({ url, authToken, intMode: 'bigint' })` from `cf-knex/turso`.

**Postgres has no `insertId` at all.** `await db('t').insert({…})` resolves to a pg
`Result` object, not an array, so destructuring it throws. Use `.returning('id')`, exactly
as with stock knex against Postgres.

**A Postgres `COMMIT` can silently roll back.** If a statement inside the transaction
already aborted it, Postgres executes the `COMMIT` as a `ROLLBACK` and reports success.
cf-knex detects this and throws `COMMIT_SILENTLY_ROLLED_BACK` instead of letting a
transaction that discarded its writes look like one that committed.

**SQLite-family databases allow one writer at a time.** On D1, Turso and libsql an open
write transaction blocks every other write across the whole database until it ends. Code
that assumes two concurrent writes can interleave will serialise instead.

**Every backend is reached through a driver, not a shim.** `db.raw()` returns that
driver's own shape, normalised only where knex itself requires it.

## Lifetime

Create the client inside the request handler and destroy it at the end. Do not cache one
in a module-level global: workerd rejects reusing I/O objects across requests with
`Cannot perform I/O on behalf of a different request`. This costs less than it sounds —
Hyperdrive pools server-side, and D1, Turso and TiDB-over-HTTP have no connection to
re-establish.

The internal pool defaults to `{ min: 0, max: 5 }` rather than knex's `{ min: 2, max: 10 }`,
because a `min` above zero pins connections open for the life of the client. Override it
through `knex: { pool: { … } }` if your usage differs.

## Errors

Every error cf-knex raises itself is a `CfKnexError` with a stable `code`. Driver errors
pass through untouched.

```ts
import { CfKnexError } from 'cf-knex'

try {
  await db('posts').select('*')
} catch (err) {
  if (err instanceof CfKnexError && err.code === 'UNSUPPORTED_CAPABILITY') {
    // …
  }
}
```

| Code | Meaning |
|---|---|
| `NO_CONNECTION` | No connection field was supplied |
| `AMBIGUOUS_CONNECTION` | More than one connection field was supplied |
| `UNKNOWN_DRIVER` | The driver could not be inferred from the config |
| `INVALID_ENGINE_DRIVER` | The driver is not valid for the given engine |
| `MISSING_DRIVER` | The driver's peer package is not installed |
| `UNSUPPORTED_CAPABILITY` | The driver cannot do this; the message names the alternative |
| `UNSUPPORTED_TRANSACTION_MODE` | An isolation level or read-only mode this driver cannot honour |
| `COMMIT_SILENTLY_ROLLED_BACK` | A `COMMIT` was executed as a `ROLLBACK` |
| `MALFORMED_DRIVER_RESULT` | The driver returned a shape cf-knex could not read |
| `INCOMPATIBLE_KNEX` | The installed knex does not expose what cf-knex needs |

Where cf-knex puts a connection URL into one of its own messages, the credentials are
stripped first — a malformed URL is reported as `postgres://***@host/db`. Errors raised by
the underlying driver are passed through as the driver wrote them.

## Tested against

Every backend below runs the same conformance suite. Local runs use Docker; the hosted
tiers run in CI against real services.

| Backend | How |
|---|---|
| MySQL 8, MariaDB 11 | Docker, direct and via a Hyperdrive-shaped config |
| Postgres 16 | Docker, direct and via a Hyperdrive-shaped config |
| libsql-server | Docker, pinned by digest |
| D1 | miniflare, via the real binding |
| TiDB Serverless | live, over HTTP |
| Turso | live |
| Neon | live, both the pooler and the direct endpoint |

The suite also runs against both ends of the declared knex peer range (3.1.0 and 3.3.0).

Where each suite runs is worth knowing. D1, libsql and TiDB-over-HTTP are exercised
*inside* workerd. `mysql2` and `pg` are not: `@cloudflare/vitest-pool-workers` cannot
import either package, a documented module-resolution limitation of that test pool rather
than of Workers. Their conformance suites therefore run under Node, and their behaviour on
workerd itself was established separately with `wrangler dev` against a live MySQL —
outbound TCP, buffered queries and row streaming all work. Every entry point is
additionally built with real wrangler on each push.

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

## License

MIT
