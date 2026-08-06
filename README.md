# cf-knex

Knex query-builder syntax on Cloudflare Workers — TiDB Serverless, MySQL, Postgres, D1
and Turso, connected directly or through Hyperdrive.

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

## Why this exists

I wanted to use TiDB Cloud Serverless from a Cloudflare Worker with knex, and could not.

Worth separating up front, because it decides which entry point you want: **self-hosted
TiDB and TiDB Dedicated speak the MySQL wire protocol**, so they are a MySQL backend here
— `mysql2` through Hyperdrive, same as any other MySQL server. **TiDB Cloud Serverless is
the one that is different**, because it also exposes an HTTP API, and that API is the only
way to reach it from a Worker with nothing in front.

The first problem was that a Worker has no TCP sockets, so `mysql2` is not an option
without putting Hyperdrive in front of the database. TiDB Cloud ships an HTTP driver for
exactly this situation — `@tidbcloud/serverless` — but knex has no dialect for it, so the
query builder and the driver had no way to meet.

The second problem is worse, and it is nothing to do with TiDB: **stock knex does not
build for a Worker at all.** `import Knex from 'knex'` reaches `knex/lib/dialects/index.js`, a
frozen map of literal `require()` calls for all twelve dialects. They are lazy at
runtime, but a Workers bundler resolves them at build time, and knex's `browser` field
neutralises only the *bare* specifiers — the mariadb dialect asks for the subpath
`mariadb/callback`, which escapes it, so the build dies before any of your code runs:

```
✘ [ERROR] Could not resolve "mariadb/callback"
```

So this started as a TiDB-Serverless-over-HTTP wrapper and grew into the general answer. cf-knex
never imports knex's main entry. It builds on knex's dialect classes directly and
supplies its own connection layer per backend, so every entry point bundles under a real
`wrangler deploy` with no `alias` entries in your `wrangler.jsonc`. That claim is a CI
gate, not a promise: every push packs the published tarball, installs it into a throwaway
project with real wrangler, and runs `wrangler deploy --dry-run` for all six entry points.

Once the plumbing existed for TiDB Serverless, the other four backends were the same
shape of work, so they are here too. You still get knex — the query builder, schema builder, and
transactions are knex's own.

## Install

```sh
pnpm add cf-knex knex
# or
yarn add cf-knex knex
# or
npm install cf-knex knex
```

Then add the driver for the backend you use. Each is an optional peer dependency; you
only need the one you actually connect with.

| Backend | Package |
|---|---|
| TiDB Cloud Serverless (HTTP) | `@tidbcloud/serverless` |
| MySQL / MariaDB / TiDB self-hosted or Dedicated (wire protocol) | `mysql2` |
| Postgres / Neon | `pg` |
| Turso / libsql | `@libsql/client` |
| D1 | *none* — the binding is the driver |

Your `wrangler.jsonc` needs Node compatibility — knex itself uses `events` and `timers`:

```jsonc
{
  "compatibility_flags": ["nodejs_compat"]
}
```

## Two ways to import

**Per-backend entry** — smallest bundle, narrowest options type:

```ts
import { createClient } from 'cf-knex/tidb'

const db = createClient({ url: env.TIDB_URL })
```

**Root entry** — pick the backend at runtime with `engine`, plus `driver` where one
engine has more than one driver. TiDB is such a case: `engine: 'mysql'` alone reaches any
TiDB over the wire protocol, and `driver: 'tidb-http'` selects TiDB Cloud Serverless's
HTTP API instead.

```ts
import { createClient } from 'cf-knex'

const db = createClient({ engine: 'mysql', driver: 'tidb-http', url: env.TIDB_URL })
```

Both return a real `Knex` instance. The per-backend entries pull in only their own
adapter; importing `cf-knex/tidb` does not bundle the Postgres or MySQL code.

## Examples

Each block is a complete Worker. `db.destroy()` at the end of the request is deliberate —
see [Lifetime](#lifetime).

### TiDB Cloud Serverless over HTTP

The case this library was written for. No Hyperdrive and no TCP — this driver speaks
TiDB Cloud's HTTP API, so it works from a Worker with nothing in front of it.

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

The `url` is the connection string TiDB Cloud gives you for the serverless driver.

**Self-hosted TiDB and TiDB Dedicated do not belong here.** They speak the MySQL wire
protocol and nothing else, so they are an ordinary MySQL backend: put Hyperdrive in front
and import `cf-knex/mysql`. `cf-knex/tidb` means specifically "TiDB Cloud Serverless over
HTTP".

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
infers `tidb-http`, not `mysql2`. That is right for TiDB Cloud Serverless and wrong for
TiDB Dedicated, which is also on `.tidbcloud.com` but speaks only the wire protocol —
set `driver: 'mysql2'` explicitly there, and for a Serverless cluster you would rather
reach through Hyperdrive.

## Capabilities

| Driver | Backend | Engine | Transactions | Streaming |
|---|---|---|---|---|
| `tidb-http` | ⚡ TiDB Cloud Serverless (HTTP) | mysql | ✅ | ❌ |
| `mysql2` | 🐬 MySQL / MariaDB / TiDB self-hosted or Dedicated | mysql | ✅ | ✅ |
| `pg` | 🐘 Postgres / Neon | postgres | ✅ | ✅ |
| `libsql` | 🪶 Turso / libsql | sqlite | ✅ | ❌ |
| `d1` | 🟠 Cloudflare D1 | sqlite | ❌ | ❌ |

Calling an unsupported capability throws `CfKnexError` with code
`UNSUPPORTED_CAPABILITY` and a message naming the alternative — never a generic driver
crash. For D1 that alternative is the binding's own `batch()`, which submits several
statements as one atomic unit.

## Things that will surprise you

These are measured behaviours, not theory. Each one is covered by a test.

**TiDB Cloud Serverless transactions over HTTP work, but not the way you would build
them.**
`@tidbcloud/serverless`'s `Connection.begin()` returns a *brand-new* `Connection` rather
than mutating the one you called it on. knex issues `BEGIN`/`COMMIT`/`ROLLBACK` as plain
SQL on the single handle it holds for the transaction's lifetime, so those statements
have nowhere to go — passed through naively, each would run on its own throwaway
session, and every write inside the block would land outside the transaction while
looking perfectly successful. cf-knex intercepts them and drives the real `Tx` object,
forwarding everything else (savepoints included) to it unchanged. This is the single
sharpest edge in the library and the reason it exists.

**TiDB Cloud Serverless over HTTP cannot stream.** `Connection.execute()` awaits `response.json()` in
full; the package exposes no cursor or chunked-read API to wrap, so `.stream()` throws
`UNSUPPORTED_CAPABILITY` rather than quietly buffering the whole result and pretending.
If you need real streaming from TiDB, reach the cluster over the MySQL wire protocol
through Hyperdrive with `cf-knex/mysql`.

**Migrations and seeds do not run inside a Worker.** knex's `package.json` maps its
`Migrator` and `Seeder` modules to a no-op through the `browser` field, and real
wrangler/esbuild honours that, so accessing `db.migrate`/`db.seed` in a deployed Worker
fails — this is knex's own packaging, not something cf-knex can make work from library
code. What cf-knex does do is turn that failure into a typed one: instead of a bare,
unattributable `TypeError: Migrator is not a constructor`, `db.migrate`/`db.seed` throw
`CfKnexError` with code `UNSUPPORTED_CAPABILITY`, naming the capability and pointing at
running migrations from your own tooling instead. Run migrations from Node or CI against
the same database — with stock knex, or `wrangler d1 migrations apply` for D1. Schema
building at runtime (`db.schema.createTable(…)`) works fine on every backend.

**`insertId` may be a `bigint`.** TiDB's `AUTO_RANDOM`, 64-bit auto-increment columns and
libsql's `lastInsertRowid` all exceed 2^53, so cf-knex does not narrow them to `number`
and lose precision. Wrap it — `Number(id)` — rather than assuming either type.

**On TiDB Cloud Serverless, `COUNT` comes back as a string.** Its HTTP driver encodes
aggregate results as decimal strings, so `(await db('t').count('* as count').first()).count`
is `'2'`, where the same query over the MySQL wire protocol gives `2`. It bites on
arithmetic and on `===`: `count > 10` compares strings, and `count === 0` is never true.
Wrap it — `Number(row.count)` — which is correct on every backend.

**Large integer *columns* need `intMode` on Turso/libsql.** The libsql driver defaults to
`intMode: 'number'`, and decoding a column value above `Number.MAX_SAFE_INTEGER` under
that mode throws a bare `RangeError` from the driver, not a `CfKnexError`. cf-knex keeps
the driver's own default rather than making every ordinary integer a `bigint` for
everyone. If your schema has integer columns that can exceed 2^53, pass
`createClient({ url, authToken, intMode: 'bigint' })` from `cf-knex/turso`.

**On SQLite-family backends a `Date` is stored as a number.** D1, Turso and libsql
receive a `Date` binding as `date.valueOf()` — epoch milliseconds — and a `boolean` as
`1`/`0`, which is exactly what knex's own `better-sqlite3` dialect does, so a codebase
moving here from knex + better-sqlite3 keeps the values it already has. Read one back
with `new Date(row.created_at)`. MySQL and Postgres are untouched: their drivers accept
`Date` and `boolean` natively and encode them for the real column type.

**D1 rejects `bigint` bindings.** `.bind(42n)` throws `D1_TYPE_ERROR` from the binding
itself. cf-knex does not convert it, because `better-sqlite3` does not either and guessing
a conversion would silently change what gets stored. Pass a `number` or a string.

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
Hyperdrive pools server-side, and D1, Turso and TiDB Serverless over HTTP have no connection to
re-establish.

**How much `destroy()` matters depends on the backend.** On `mysql2`, `pg` and `libsql`
it ends real sockets and clients that would otherwise be left for the server to time out.
On D1 and TiDB Serverless over HTTP the adapter's `destroy()` is an empty function — there is no
socket and no server-side session — so it is there for uniformity, and dropping it costs
you nothing. The examples keep it everywhere so that switching backends never silently
turns a no-op into a leak.

cf-knex cannot call it for you: it never sees your `Response`, so it cannot know when the
request is done. Closing after each query would break transactions and multi-statement
handlers. If you would rather not `await` it, `ctx.waitUntil(db.destroy())` works.

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
| `TRANSACTION_ESCAPED` | A statement ran outside its transaction, where `ROLLBACK` cannot undo it (TiDB Cloud Serverless HTTP) |
| `MALFORMED_DRIVER_RESULT` | The driver returned a shape cf-knex could not read |
| `INCOMPATIBLE_KNEX` | The installed knex does not expose what cf-knex needs |

Where cf-knex puts a connection URL into one of its own messages, the credentials are
stripped first. Both places a secret rides in a URL are covered — the userinfo section and
the query string:

```
cannot infer a driver from url 'oracle://***@host/db' — set driver explicitly
cannot infer a driver from url 'https://db.turso.io/?authToken=***' — set driver explicitly
```

Every query value is masked, not just parameters whose names look like credentials. Errors
raised by the underlying driver are passed through as the driver wrote them.

## Tested against

Every backend below runs the same conformance suite. Local runs use Docker; the hosted
tiers run in CI against real services.

| Backend | How |
|---|---|
| MySQL 8, MariaDB 11 | Docker, direct and via a Hyperdrive-shaped config |
| Postgres 16 | Docker, direct and via a Hyperdrive-shaped config |
| libsql-server | Docker, pinned by digest |
| D1 | miniflare, via the real binding |
| TiDB Cloud Serverless | live, over HTTP |
| Turso | live |
| Neon | live, both the pooler and the direct endpoint |

The suite also runs against both ends of the declared knex peer range (3.1.0 and 3.3.0).

Where each suite runs is worth knowing. D1, libsql and TiDB Serverless over HTTP are exercised
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
