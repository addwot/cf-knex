# [cf-knex](../README.md) examples and guide

> **One directory per database, each a complete Cloudflare Worker you can `wrangler dev`
> as-is — followed by everything the package README leaves out.**

- [The examples](#the-examples) · [Connecting](#connecting) · [Configuration](#configuration)
- [Things that will surprise you](#things-that-will-surprise-you) · [Lifetime](#lifetime) · [Errors](#errors)
- [Tested against](#tested-against) · [Why this exists](#why-this-exists)
- [Knex.js query-builder docs](https://knexjs.org/) · [package README](../README.md) · [CONTRIBUTING](../CONTRIBUTING.md)

## The examples

Each has its own `package.json`, `wrangler.jsonc`, `src/index.ts` and README. They are
reference material, not a workspace: not part of the repo's build, not published to npm,
and they install `cf-knex` from the registry like any consumer would. Their TypeScript
**is** checked against the real API on every CI run (`pnpm check:examples`), so a snippet
here cannot silently drift out of date.

| Example | Entry point | Driver | Transactions | Streaming |
|---|---|---|---|---|
| [`d1`](d1) | `cf-knex/d1` | *none — the binding is the driver* | ✗ | ✗ |
| [`turso`](turso) | `cf-knex/turso` | `@libsql/client` | ✓ | ✗ |
| [`postgres`](postgres) | `cf-knex/postgres` | `pg` | ✓ | ✓ |
| [`neon`](neon) | `cf-knex/postgres` | `pg` | ✓ | ✓ |
| [`mysql`](mysql) | `cf-knex/mysql` | `mysql2` | ✓ | ✓ |
| [`mariadb`](mariadb) | `cf-knex/mysql` | `mysql2` | ✓ | ✓ |
| [`tidb`](tidb) | `cf-knex/tidb` | `@tidbcloud/serverless` | ✓ | ✗ |

Two of these are the same backend as a neighbour, deliberately:

- **`neon`** is Postgres. There is no Neon adapter — it is the `pg` driver, and the
  example exists to cover the pooled/direct endpoint choice.
- **`mariadb`** is the MySQL wire protocol. It uses `mysql2`, never the `mariadb`
  package, and the example exists to explain why that matters for Workers.

```sh
cd examples/postgres
pnpm install       # or: yarn install / npm install
npx wrangler dev
```

Each README lists the bindings or secrets that example needs first, and every
`wrangler.jsonc` here sets `nodejs_compat`, which is required.

## Connecting

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

The blocks below show only what differs between backends — the surrounding Worker is the
[example in the package README](../README.md#example), unchanged.

### TiDB Cloud Serverless over HTTP

The case this library was written for. No Hyperdrive and no TCP — this driver speaks
TiDB Cloud's HTTP API, so it works from a Worker with nothing in front of it. The `url` is
the connection string TiDB Cloud gives you for the serverless driver.

```ts
import { createClient } from 'cf-knex/tidb'

const db = createClient({ url: env.TIDB_URL })
await db('posts').count('* as n').first()
```

**Self-hosted TiDB and TiDB Dedicated do not belong here.** They speak the MySQL wire
protocol and nothing else, so they are an ordinary MySQL backend: put Hyperdrive in front
and import `cf-knex/mysql`. `cf-knex/tidb` means specifically "TiDB Cloud Serverless over
HTTP".

**Nothing bounds a request unless you ask.** `@tidbcloud/serverless` calls `fetch` with no
signal, no timeout and no retry, so a request that never comes back never comes back — the
Worker waits until the platform kills it. We watched a statement that normally takes ~1 s
hang past 30 s against an otherwise healthy cluster, while every other statement in the
same run kept its usual timing. Set `timeoutMs` and you get a `CfKnexError` you can catch:

```ts
const db = createClient({ url: env.TIDB_URL, timeoutMs: 10_000 })
```

Opt-in rather than defaulted, because the bound is not free. The abort is local, so a
statement that times out **may still be applied** server-side — treat the error as unknown
outcome, not as "did not happen", and pick a budget above the slowest query you expect.
This is the only driver with the option: the other four ride transports that already time
out on their own.

For anything more specific — retries, tracing, a per-statement budget — pass your own
`fetch`. `timeoutMs` composes on top of it rather than around the global:

```ts
const db = createClient({ url: env.TIDB_URL, fetch: (input, init) => tracedFetch(input, init) })
```

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

## Configuration

```ts
type ClientConfig = {
  engine: 'mysql' | 'postgres' | 'sqlite'
  driver?: 'mysql2' | 'tidb-http' | 'pg' | 'd1' | 'libsql'
  url?: string
  authToken?: string          // libsql/Turso
  timeoutMs?: number          // tidb-http — per-request budget, no default
  fetch?: typeof fetch        // tidb-http — replaces the fetch given to the driver
  connection?: Credentials
  hyperdrive?: Hyperdrive     // the binding, passed straight through
  binding?: D1Database
  knex?: Record<string, unknown>  // merged into the Knex.js config (pool, log, …)
}
```

Exactly one of `url`, `connection`, `hyperdrive` and `binding` may be present; two or more
is `AMBIGUOUS_CONNECTION` rather than a silent precedence rule.

Calling a capability a backend does not have throws `CfKnexError` with code
`UNSUPPORTED_CAPABILITY` and a message naming the alternative — never a generic driver
crash. For D1 that alternative is the binding's own `batch()`, which submits several
statements as one atomic unit.

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

## Things that will surprise you

Measured behaviours, each covered by a test.

**Aggregates come back as strings on most backends, and which ones differs per backend.**
Every driver encodes results that can exceed 2^53 as decimal strings rather than lose
precision, but they disagree about where that line falls:

| | `count()` | `sum()` | `avg()` | `max()` / `min()` |
|---|---|---|---|---|
| `tidb-http` | `'2'` | `'5'` | `'2.5000'` | `3` |
| `pg` | `'2'` | `'5'` | `'2.5000000000000000'` | `3` |
| `mysql2` | `2` | `'5'` | `'2.5000'` | `3` |
| `libsql` / D1 | `2` | `5` | `2.5` | `3` |

`count > 10` compares strings and `count === 0` is never true, so wrap everything but
`max`/`min` in `Number()`. The trap is `mysql2`: a number for `count()` but a string for
`sum()`, so code written against MySQL breaks on `count` specifically when it moves to
TiDB Serverless or Postgres.

**`insertId` may be a `bigint`.** TiDB's `AUTO_RANDOM`, 64-bit auto-increment columns and
libsql's `lastInsertRowid` all exceed 2^53, so they are not narrowed to `number`. Wrap
with `Number(id)` rather than assuming either type.

**Postgres has no `insertId` at all.** `insert()` resolves to a pg `Result` object, not an
array, so destructuring it throws. Use `.returning('id')`, as with stock Knex.js.

**Migrations and seeds do not run inside a Worker.** Knex.js's `browser` field maps its
`Migrator` and `Seeder` to a no-op and wrangler honours it, so `db.migrate`/`db.seed`
throw `UNSUPPORTED_CAPABILITY` instead of a bare `TypeError: Migrator is not a
constructor`. Run them from Node or CI against the same database, or
`wrangler d1 migrations apply` for D1. Runtime schema building
(`db.schema.createTable(…)`) works everywhere.

**TiDB Serverless transactions over HTTP are intercepted.** `@tidbcloud/serverless`'s
`Connection.begin()` returns a *new* connection instead of mutating the one you hold, so
Knex.js's plain `BEGIN`/`COMMIT`/`ROLLBACK` would each run on a throwaway session and every
write would land outside the transaction while looking successful. cf-knex drives the real
`Tx` object instead, savepoints included.

**Statements inside one TiDB transaction run one at a time.** A transaction is a single
server-side session, and a session admits one statement at a time — parallel ones return
`invalid connection` ([serverless-js#61][tidb-61], closed as "run the transaction
serially"). So cf-knex serialises them for you: `await Promise.all([trx(…).insert(…),
trx(…).insert(…)])` behaves, it just does not overlap. Statements *outside* a transaction
stay parallel, bounded by `pool.max`.

**TiDB Serverless session state is shared across every connection, not per client.** Each
non-transactional connection for one credential is handed the *same* server-side session
(its `TiDB-Session` token is byte-identical and prefixed `stateless_`). A `SET @var`, a
`USE`, or any session-scoped `SET` is therefore visible to every other query using those
credentials — including one issued by a separate `createClient(…)`. Do not use session
state to carry anything request-scoped. Transactions are exempt: `BEGIN` allocates a
private `txn_`-prefixed session.

[tidb-61]: https://github.com/tidbcloud/serverless-js/issues/61

**TiDB Serverless over HTTP cannot stream.** The driver awaits `response.json()` in full
and exposes no cursor, so `.stream()` throws rather than buffering the whole result and
pretending. Reach the cluster through Hyperdrive with `cf-knex/mysql` if you need it.

**Large integer columns need `intMode: 'bigint'` on Turso/libsql**, passed to
`createClient` from `cf-knex/turso`. The driver defaults to `'number'` and throws a bare
`RangeError` — not a `CfKnexError` — above `Number.MAX_SAFE_INTEGER`.

**On SQLite-family backends a `Date` is stored as a number** (`date.valueOf()`, epoch
milliseconds) and a `boolean` as `1`/`0`, matching Knex.js's own `better-sqlite3` dialect.
Read one back with `new Date(row.created_at)`. **D1 also rejects `bigint` bindings** with
`D1_TYPE_ERROR`; pass a `number` or a string. MySQL and Postgres are untouched.

**A Postgres `COMMIT` can silently roll back.** If a statement inside the transaction
already aborted it, Postgres executes the `COMMIT` as a `ROLLBACK` and reports success.
cf-knex throws `COMMIT_SILENTLY_ROLLED_BACK` instead.

**SQLite-family databases allow one writer at a time**, so concurrent writes on D1, Turso
and libsql serialise rather than interleave. And `db.raw()` returns the driver's own
shape, normalised only where Knex.js itself requires it.

## Lifetime

Create the client inside the request handler. Do not cache one in a module-level global:
workerd rejects reusing I/O objects across requests with `Cannot perform I/O on behalf of
a different request`. It costs less than it sounds — Hyperdrive pools server-side, and D1,
Turso and TiDB over HTTP have no connection to re-establish.

### What actually needs cleaning up

Forgetting `db.destroy()` after ordinary queries leaks nothing on any backend. That is
measured, not assumed — against a live TiDB Cloud Serverless cluster, a live Turso
database, a deployed Neon instance, and local MySQL and Postgres, counting server-side
sessions rather than trusting the driver's own flags:

| Backend | After queries, no `destroy()` | After an **abandoned transaction** |
|---|---|---|
| 🟠 D1 | nothing to close | no transactions to abandon |
| ⚡ TiDB over HTTP | nothing to close — no session is held between calls | **locks held for minutes**, until TiDB expires them |
| 🪶 Turso | nothing to close — connecting does no I/O until the first query | **all writers blocked ~10–15 s** (one writer at a time) |
| 🐬 MySQL / MariaDB | measured: zero connections left behind | the server rolls back on disconnect |
| 🐘 Postgres / Neon | measured: zero connections left behind | the server rolls back on disconnect |

So the thing worth caring about is not the client, it is an **unfinished transaction**.
The callback form finishes on every path, including a throw:

```ts
await db.transaction(async trx => {
  await trx('users').insert({ email })
})
```

The bare transactor form does not, and that is what strands a lock:

```ts
const trx = await db.transaction()
await trx('users').insert({ email })
// an early return or a throw here never commits and never rolls back
```

Prefer `await using`, which rolls back at scope exit if you did not finish it:

```ts
await using trx = await db.transaction()
await trx('users').insert({ email })
await trx.commit()
```

**The two forms disagree about what happens when you do nothing.** The callback form
*commits* for you when the body returns normally. `await using` *rolls back* unless you
call `commit()` yourself — that `await trx.commit()` above is required, not decoration.
Dropping it is silent: no error, no warning, and the insert simply is not there. Rolling
back is the right default for a disposer, and it is what every other language does with
this pattern, but it is the opposite of the callback form. Read a refactor between the two
carefully.

`await using` needs TypeScript 5.2+ with `lib` at `esnext.disposable` or later, and a
runtime that supports it (workerd does). Without it, use the callback form.

### `db.destroy()`

Still supported, still the explicit way to tear a client down, and safe to call more than
once — repeat calls await the first rather than tearing the adapter down again. cf-knex
cannot call it for you: it never sees your `Response`, and closing after each query would
break transactions. `await using db = createClient(…)` calls it for you at scope exit.

`db.destroy()` is bounded. If a connection is still checked out — which in practice means
a transaction nobody finished — it waits `destroyTimeoutMs`, warns saying exactly that,
and returns. It does **not** force the connection closed, and it does not pretend to: the
transaction is already stranded at that point, and on TiDB and Turso the locks stay held
server-side until the backend expires them. Nothing inside a Worker can shorten that. Not
stranding it in the first place is the fix, which is what the disposer above is for.

`destroyTimeoutMs` (6000 by default, settable per client) is the budget for `destroy()`
as a whole, not per internal step. Teardown waits on the connection pool and then on the
adapter, and the adapter gets whatever the pool left, so `destroy()` costs you at most
that figure end to end.

**One caveat worth knowing before you rely on the warning.** It is emitted by `destroy()`,
and this guide has just told you that you do not need to call `destroy()` after ordinary
queries. Both are true, and together they leave a gap: strand a transaction in a handler
that never calls `destroy()`, and nothing says so — not in the logs, not in the response.
There is no hook in a Worker that would let cf-knex notice at end of request. So treat the
warning as a backstop for when you *do* tear down, and treat `await using` as the actual
answer: it makes the mistake impossible rather than merely reported.

`ctx.waitUntil(db.destroy())` works if you would rather not `await` it — but it hides that
warning behind an already-returned response, so prefer `await` while you are still
establishing that your transactions are balanced.

The pool defaults to `{ min: 0, max: 5 }` rather than Knex.js's `{ min: 2, max: 10 }`,
because a `min` above zero pins connections open for the life of the client. Override it
through `knex: { pool: { … } }`.

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
| `REQUEST_TIMEOUT` | A request exceeded the `timeoutMs` you set and was aborted; the server may still apply it (TiDB Cloud Serverless HTTP) |
| `MALFORMED_DRIVER_RESULT` | The driver returned a shape cf-knex could not read |
| `INCOMPATIBLE_KNEX` | The installed Knex.js does not expose what cf-knex needs |

Where cf-knex puts a connection URL into one of its own messages, credentials are stripped
first — both places a secret rides in a URL, and every query value rather than only the
ones whose names look like credentials:

```
cannot infer a driver from url 'oracle://***@host/db' — set driver explicitly
cannot infer a driver from url 'https://db.turso.io/?authToken=***' — set driver explicitly
```

## Tested against

Every backend below runs the same conformance suite, against both ends of the declared
Knex.js peer range (3.1.0 and 3.3.0). Local runs use Docker; the hosted tiers run in CI
against real services.

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

The two "Hyperdrive-shaped config" rows use `localConnectionString`: the binding's *shape*,
connected straight to Docker. They prove the code path, not the product — the last row is
a real Hyperdrive configuration, driven from a Worker.

`mysql2` and `pg` suites run under Node because `@cloudflare/vitest-pool-workers` cannot
import either package, a limitation of that test pool rather than of Workers; their
behaviour on workerd was checked separately with `wrangler dev` against a live MySQL. D1,
libsql and TiDB over HTTP are exercised inside workerd, and every entry point is built
with real wrangler on each push.

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
