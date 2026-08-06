# [cf-knex](https://www.npmjs.com/package/cf-knex)

[![npm version](https://img.shields.io/npm/v/cf-knex.svg)](https://npmjs.org/package/cf-knex)
[![CI](https://github.com/addwot/cf-knex/actions/workflows/ci.yml/badge.svg)](https://github.com/addwot/cf-knex/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/cf-knex.svg)](LICENSE)

> **Knex.js query-builder syntax on Cloudflare Workers — _no TCP required_.**

A multi-backend (TiDB Cloud Serverless, MySQL, MariaDB, Postgres, Neon, Cloudflare D1,
Turso) connector for Workers, connected directly or through Hyperdrive, featuring:

- [transactions](#capabilities) on every backend but D1
- [row streaming](#capabilities) on MySQL and Postgres
- [Hyperdrive bindings](#postgres-through-hyperdrive) passed straight through
- [zero configuration](#zero-config-from-bindings) from a D1 or Hyperdrive binding
- [per-backend entry points](#two-ways-to-import), 2.6–3.3 kB brotli, one adapter each
- [typed errors](#errors) where a backend cannot do what was asked, never a driver crash
- a [conformance suite](#tested-against) run against every backend, hosted tiers included

Knex.js 3 (`^3.1.0`) is a peer dependency and does the real work: the query builder,
schema builder and transactions are Knex.js's own.

- Query-builder documentation lives at [knexjs.org](https://knexjs.org/) — it all applies here
- A complete Worker per backend: [`examples/`](examples/)
- Where the backends disagree: [Things that will surprise you](#things-that-will-surprise-you)
- Report bugs and request features on the [issues page](https://github.com/addwot/cf-knex/issues); [CONTRIBUTING.md](CONTRIBUTING.md) covers pull requests
- Release notes: [CHANGELOG.md](CHANGELOG.md)

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

I wanted to use TiDB Cloud Serverless from a Cloudflare Worker with Knex.js, and could not.

A Worker has no TCP sockets, so `mysql2` is out unless Hyperdrive sits in front — and
Hyperdrive [refuses that tier](#driver-inference) at config-creation time, so there is no
TCP path to fall back to. TiDB Cloud ships an HTTP driver for exactly this situation,
`@tidbcloud/serverless`, but Knex.js has no dialect for it, so the query builder and the
driver had no way to meet.

The second problem is worse, and it is nothing to do with TiDB: **stock Knex.js does not
build for a Worker at all.** `import Knex from 'knex'` reaches `knex/lib/dialects/index.js`, a
frozen map of literal `require()` calls for all twelve dialects. They are lazy at
runtime, but a Workers bundler resolves them at build time, and Knex.js's `browser` field
neutralises only the *bare* specifiers — the mariadb dialect asks for the subpath
`mariadb/callback`, which escapes it, so the build dies before any of your code runs:

```
✘ [ERROR] Could not resolve "mariadb/callback"
```

So cf-knex never imports Knex.js's main entry. It builds on Knex.js's dialect classes
directly — the query builder, schema builder and transactions are Knex.js's own — and
supplies its own connection layer per backend, so every entry point bundles under a real
`wrangler deploy` with no `alias` entries in your `wrangler.jsonc`. That claim is a CI
gate, not a promise: every push packs the published tarball, installs it into a throwaway
project with real wrangler, and runs `wrangler deploy --dry-run` for all six entry points.

Once the plumbing existed for TiDB Serverless, the other four backends were the same
shape of work, so they are here too.

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

Your `wrangler.jsonc` needs Node compatibility — Knex.js itself uses `events` and `timers`:

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

The first block is a complete Worker; the rest show only what differs, inside the same
`fetch` handler and the same `try`/`finally`. `db.destroy()` at the end of the request is
deliberate — see [Lifetime](#lifetime).

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

const db = createClient({ binding: env.DB })          // env: { DB: D1Database }
await db('posts').orderBy('id', 'desc').limit(10)
```

### Turso (libsql)

```ts
import { createClient } from 'cf-knex/turso'

const db = createClient({ url: env.TURSO_URL, authToken: env.TURSO_AUTH_TOKEN })
const [id] = await db('posts').insert({ title: 'hello' })
```

### Postgres through Hyperdrive

```ts
import { createClient } from 'cf-knex/postgres'

const db = createClient({ hyperdrive: env.HYPERDRIVE })  // env: { HYPERDRIVE: Hyperdrive }
// Postgres has no insertId — ask for it with .returning(), as with stock Knex.js.
const [row] = await db('posts').insert({ title: 'hello' }).returning('id')
```

### MySQL through Hyperdrive

```ts
import { createClient } from 'cf-knex/mysql'

const db = createClient({ hyperdrive: env.HYPERDRIVE })
await db.transaction(async (trx) => {
  await trx('accounts').where('id', 1).decrement('balance', 100)
  await trx('accounts').where('id', 2).increment('balance', 100)
})
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

const db = fromEnv(env)
await db('posts').select('*')
```

### Typed rows

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
  knex?: Record<string, unknown>  // merged into the Knex.js config (pool, log, …)
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
set `driver: 'mysql2'` explicitly there.

**You cannot put Hyperdrive in front of TiDB Cloud Serverless.** Creating the config
fails before you get as far as a Worker:

```
Failed to connect to the provided database:
Hyperdrive does not currently support MySQL AuthSwitchRequest messages
```

Observed 2026-08-06 against a Serverless cluster. Hyperdrive's MySQL support does not
carry the authentication handshake that tier requires, so the HTTP driver is not the
better option but the only one. TiDB Dedicated and self-hosted TiDB are unaffected —
ordinary MySQL origins, fine through Hyperdrive with `cf-knex/mysql`.

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
than mutating the one you called it on. Knex.js issues `BEGIN`/`COMMIT`/`ROLLBACK` as plain
SQL on the single handle it holds for the transaction's lifetime, so passed through
naively each would run on its own throwaway session, and every write inside the block
would land outside the transaction while looking perfectly successful. cf-knex intercepts
them and drives the real `Tx` object, forwarding everything else (savepoints included) to
it unchanged.

**TiDB Cloud Serverless over HTTP cannot stream.** `Connection.execute()` awaits `response.json()` in
full; the package exposes no cursor or chunked-read API to wrap, so `.stream()` throws
`UNSUPPORTED_CAPABILITY` rather than quietly buffering the whole result and pretending.
If you need real streaming from TiDB, reach the cluster over the MySQL wire protocol
through Hyperdrive with `cf-knex/mysql`.

**Migrations and seeds do not run inside a Worker.** Knex.js's `package.json` maps its
`Migrator` and `Seeder` modules to a no-op through the `browser` field, and real
wrangler/esbuild honours that — Knex.js's own packaging, not something cf-knex can work
around from library code. All cf-knex can do is make the failure legible: instead of a
bare `TypeError: Migrator is not a constructor`, `db.migrate`/`db.seed` throw
`CfKnexError` with code `UNSUPPORTED_CAPABILITY`. Run migrations from Node or CI against
the same database — with stock Knex.js, or `wrangler d1 migrations apply` for D1. Schema
building at runtime (`db.schema.createTable(…)`) works fine on every backend.

**`insertId` may be a `bigint`.** TiDB's `AUTO_RANDOM`, 64-bit auto-increment columns and
libsql's `lastInsertRowid` all exceed 2^53, so cf-knex does not narrow them to `number`
and lose precision. Wrap it — `Number(id)` — rather than assuming either type.

**Aggregates come back as strings on most backends, and which ones differ per backend.**
Every driver here encodes results that can exceed 2^53 as decimal strings rather than lose
precision, but they disagree about where that line falls:

| | `count()` | `sum()` | `avg()` | `max()` / `min()` |
|---|---|---|---|---|
| `tidb-http` | `'2'` | `'5'` | `'2.5000'` | `3` |
| `pg` | `'2'` | `'5'` | `'2.5000000000000000'` | `3` |
| `mysql2` | `2` | `'5'` | `'2.5000'` | `3` |
| `libsql` / D1 | `2` | `5` | `2.5` | `3` |

Measured, not inferred — the same query on each backend. It bites on arithmetic and on
`===`: `count > 10` compares strings, and `count === 0` is never true. Wrap every
aggregate except `max`/`min` in `Number()`. The trap is `mysql2`'s row: a number for
`count()` but a string for `sum()`, so code written against MySQL and moved to TiDB
Serverless or Postgres breaks on `count` specifically.

**Large integer *columns* need `intMode` on Turso/libsql.** The libsql driver defaults to
`intMode: 'number'`, and decoding a column value above `Number.MAX_SAFE_INTEGER` under
that mode throws a bare `RangeError` from the driver, not a `CfKnexError`. cf-knex keeps
the driver's own default rather than making every ordinary integer a `bigint` for
everyone. If your schema has integer columns that can exceed 2^53, pass
`createClient({ url, authToken, intMode: 'bigint' })` from `cf-knex/turso`.

**On SQLite-family backends a `Date` is stored as a number.** D1, Turso and libsql
receive a `Date` binding as `date.valueOf()` — epoch milliseconds — and a `boolean` as
`1`/`0`, which is exactly what Knex.js's own `better-sqlite3` dialect does, so a codebase
moving here from Knex.js + better-sqlite3 keeps the values it already has. Read one back
with `new Date(row.created_at)`. MySQL and Postgres are untouched: their drivers accept
`Date` and `boolean` natively and encode them for the real column type.

**D1 rejects `bigint` bindings.** `.bind(42n)` throws `D1_TYPE_ERROR` from the binding
itself. cf-knex does not convert it, because `better-sqlite3` does not either and guessing
a conversion would silently change what gets stored. Pass a `number` or a string.

**Postgres has no `insertId` at all.** `await db('t').insert({…})` resolves to a pg
`Result` object, not an array, so destructuring it throws. Use `.returning('id')`, exactly
as with stock Knex.js against Postgres.

**A Postgres `COMMIT` can silently roll back.** If a statement inside the transaction
already aborted it, Postgres executes the `COMMIT` as a `ROLLBACK` and reports success.
cf-knex detects this and throws `COMMIT_SILENTLY_ROLLED_BACK` instead of letting a
transaction that discarded its writes look like one that committed.

**SQLite-family databases allow one writer at a time.** On D1, Turso and libsql an open
write transaction blocks every other write across the whole database until it ends. Code
that assumes two concurrent writes can interleave will serialise instead.

**Every backend is reached through a driver, not a shim.** `db.raw()` returns that
driver's own shape, normalised only where Knex.js itself requires it.

## Lifetime

Create the client inside the request handler and destroy it at the end. Do not cache one
in a module-level global: workerd rejects reusing I/O objects across requests with
`Cannot perform I/O on behalf of a different request`. This costs less than it sounds —
Hyperdrive pools server-side, and D1, Turso and TiDB Serverless over HTTP have no connection to
re-establish.

**How much `destroy()` matters depends on the backend.** On `mysql2`, `pg` and `libsql` it
ends real sockets that would otherwise be left for the server to time out. On D1 and TiDB
Serverless over HTTP it is an empty function — no socket, no server-side session. The
examples call it everywhere so that switching backends never turns a no-op into a leak.

cf-knex cannot call it for you: it never sees your `Response`, and closing after each
query would break transactions. `ctx.waitUntil(db.destroy())` works if you would rather
not `await` it.

The internal pool defaults to `{ min: 0, max: 5 }` rather than Knex.js's `{ min: 2, max: 10 }`,
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
| `INCOMPATIBLE_KNEX` | The installed Knex.js does not expose what cf-knex needs |

Where cf-knex puts a connection URL into one of its own messages, the credentials are
stripped first. Both places a secret rides in a URL are covered — the userinfo section and
the query string:

```
cannot infer a driver from url 'oracle://***@host/db' — set driver explicitly
cannot infer a driver from url 'https://db.turso.io/?authToken=***' — set driver explicitly
```

Every query value is masked, not just parameters whose names look like credentials.

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
| Neon behind a real Hyperdrive binding | live, `wrangler dev --remote` |

The two "Hyperdrive-shaped config" rows use `localConnectionString`, which gives the
binding's *shape* but connects straight to Docker — they prove the code path, not the
product. The last row is a real Hyperdrive configuration driven from a Worker: DDL,
`insert … returning`, a committed and a rolled-back transaction, streaming and aggregates
all behaved as they do direct.

The suite also runs against both ends of the declared Knex.js peer range (3.1.0 and 3.3.0).

D1, libsql and TiDB Serverless over HTTP are exercised *inside* workerd. `mysql2` and `pg`
are not: `@cloudflare/vitest-pool-workers` cannot import either package, a documented
limitation of that test pool rather than of Workers. Their conformance suites run under
Node, and their behaviour on workerd was established separately with `wrangler dev`
against a live MySQL — outbound TCP, buffered queries and row streaming all work. Every
entry point is additionally built with real wrangler on each push.

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

[CONTRIBUTING.md](CONTRIBUTING.md) covers the rest: which directory a test belongs in and
why, when a changeset is needed, and what CI does and does not check on a pull request.

## License

MIT
