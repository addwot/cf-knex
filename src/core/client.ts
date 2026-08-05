import Knex from 'knex'
import type { Knex as KnexType } from 'knex'
// knex ships types only for its public entry point; these deep CJS dialect
// paths have no shipped declarations — see ./knex-dialects.d.ts.
import Client_MySQL2 from 'knex/lib/dialects/mysql2'
import Client_PG from 'knex/lib/dialects/postgres'
import Client_SQLite3 from 'knex/lib/dialects/sqlite3'
import { CfKnexError } from './errors'
import { toKnexResponse } from './response'
import type { Dialect, DriverAdapter } from './types'

// Static imports (not `createRequire`) so these paths are visible to the
// bundler and a resolution failure surfaces at import time.
//
// Known limitation: each dialect class builds its own internal `Logger`,
// and that instance's `colorette` dependency fails to resolve under this
// project's vitest-pool-workers test harness — any `logger.warn/error/
// deprecate` call inside a dialect constructor throws ("Cannot read
// properties of undefined (reading 'red')"). Not fixable from here;
// `initializeDriver()` and the sqlite defaults below instead avoid ever
// calling into that path.
const DIALECT_CLASSES: Record<Dialect, unknown> = {
  mysql: Client_MySQL2,
  postgres: Client_PG,
  sqlite: Client_SQLite3,
}

function loadDialect(dialect: Dialect): new (...args: never[]) => unknown {
  const Base = DIALECT_CLASSES[dialect]
  // Runtime guard for a future knex version that keeps this path resolvable
  // but changes what it exports (e.g. a named export instead of default).
  if (typeof Base !== 'function') {
    throw new CfKnexError('INCOMPATIBLE_KNEX', `'knex/lib/dialects' entry for '${dialect}' did not export a constructor`)
  }
  return Base as new (...args: never[]) => unknown
}

const DEFAULT_LOG = {
  // Plain console, not colorette-colored: no TTY to render ANSI codes here,
  // and colorette isn't reliable to resolve in this harness (see above).
  warn: (message: string) => console.warn(message),
  error: (message: string) => console.error(message),
  deprecate: (message: string) => console.warn(message),
}

// `loadDialect` deliberately types the base dialect class's instance as
// `unknown` — this file otherwise never calls an inherited member by name,
// so there is nothing to type-check against. `destroy()` below is the one
// exception: it calls `super.destroy()` to reuse knex's own pool-teardown
// sequence, so the instance type is refined with just that one member typed
// (an intersection keeps every other inherited member available as
// `unknown`, same as before).
type KnexClientInstance = Record<string, unknown> & {
  destroy(callback?: (err?: unknown) => void): Promise<void>
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- mirrors knex's own public `Knex<TRecord, TResult>` signature (node_modules/knex/types/index.d.ts); widening it would diverge from knex's generics and break `.select()`/`.selec()` type-checking.
export function createKnexClient<TRecord extends {} = any, TResult = unknown[]>(
  adapter: DriverAdapter,
  knexOptions: Record<string, unknown> = {},
): KnexType<TRecord, TResult> {
  const Base = loadDialect(adapter.dialect) as new (...args: never[]) => KnexClientInstance

  class CfKnexClient extends Base {
    // knex's base Client constructor calls this whenever `config.connection`
    // is truthy, and each dialect's implementation tries to `require()` the
    // real native driver package (mysql2/pg/sqlite3) — unavailable in
    // workerd and unnecessary, since `adapter` supplies connections instead.
    // Nothing below reads `this.driver`, so no-opping this is safe.
    initializeDriver() {}

    // Deliberately NOT overriding `acquireConnection` / `releaseConnection`
    // (knex's higher-level, per-query API): the base `Client` implementation
    // of those two calls `this.pool.acquire()` / `this.pool.release()`,
    // which is exactly what makes knex's tarn pool real. Overriding them
    // directly — this project's first attempt — calls straight into
    // `adapter` once per query and bypasses tarn entirely, so the pool
    // never tracks a handle and never reaps it; see `DriverAdapter`'s doc
    // comment in ./types.ts for the fallout that caused. Overriding the
    // lower-level hooks below instead lets tarn own pooling and only calls
    // into `adapter` when tarn itself decides to create or evict a handle.

    async acquireRawConnection() {
      return adapter.acquire()
    }

    async destroyRawConnection(handle: unknown) {
      await adapter.release(handle)
    }

    // knex's stock mysql2 dialect implements this as `connection &&
    // !connection._fatalError && !connection._protocolError &&
    // !connection._closing && !connection.stream.destroyed`
    // (node_modules/knex/lib/dialects/mysql2/index.js) — it assumes the
    // pooled handle is always a live mysql2 socket with those exact fields.
    // That is not true in general: `adapter` owns the handle, and for the
    // tidb-http/d1/libsql adapters this same class is reused for, it may not
    // have any of them. Reading `.stream.destroyed` on one of those handles
    // would throw (not just return false), which tarn would treat as
    // "invalid, discard immediately" — silently defeating pooling on every
    // acquire. Handle
    // liveness is genuinely the adapter's concern, not the pool's — but
    // "the adapter's concern" has to mean something the adapter can act on,
    // not just a comment here promising it does: `DriverAdapter.validate`
    // (src/core/types.ts) is the hook for that. Delegate to it when an
    // adapter implements it (a handle that can go stale between queries,
    // e.g. mysql2's TCP connection, needs this to avoid the pool handing
    // out a connection MySQL already killed server-side); default to always
    // valid when it doesn't (HTTP-backed and binding-backed handles can't go
    // stale this way, and knex's own stricter default would wrongly discard
    // them).
    validateConnection(handle: unknown): boolean {
      return adapter.validate ? adapter.validate(handle) : true
    }

    async _query(handle: unknown, obj: Record<string, unknown>) {
      const raw = await adapter.execute(handle, obj.sql as string, (obj.bindings as unknown[]) ?? [])
      return toKnexResponse(adapter.dialect, raw, obj)
    }

    _stream() {
      throw CfKnexError.unsupported(adapter.driver, 'streaming', 'Use .limit()/.offset() to paginate.')
    }

    // knex's own `Client.destroy()` only tears down the pool — which, now
    // that acquire/destroy are wired to real tarn hooks above, does mean
    // every handle tarn still holds gets a `destroyRawConnection` /
    // `adapter.release()` call. But `Client.destroy()` has no notion of
    // `adapter`, so without this override `knex.destroy()` would never
    // reach `adapter.destroy()` and any adapter-level state that outlives
    // individual handles (e.g. src/adapters/mysql2.ts's own bookkeeping)
    // would go untorn-down. `knex.destroy(callback)` (make-knex.js) calls
    // `this.client.destroy(callback)` directly and polymorphically, so
    // overriding `destroy` here is reached the same way the overrides above
    // are. `super.destroy()` first reuses the base pool-teardown sequence
    // (including its own `_ownsPool` guard) before `adapter.destroy()` runs.
    //
    // But `this` is not always the real client: knex's transaction machinery
    // (execution/transaction.js's `makeTxClient`) builds a *transactor*
    // client via `Object.create(client.constructor.prototype)` — sharing
    // this exact prototype, so `trx.destroy()` resolves to this same method
    // — and marks it with an own `transacting: true` property the real
    // client never has. That transactor has no pool of its own (`super.destroy()`
    // already no-ops for it, since its inherited `this.pool` is `undefined`),
    // but nothing before this fix-round stopped `adapter.destroy()` from
    // running anyway: calling `trx.destroy()` inside a transaction would
    // tear down every connection the *adapter* holds, including the one the
    // transaction itself is still using to COMMIT — breaking the parent
    // `db` permanently, not just the transaction. Guard it the same way
    // knex's own pool implicitly does for itself.
    async destroy(callback?: (err?: unknown) => void): Promise<void> {
      if ((this as unknown as { transacting?: boolean }).transacting) {
        if (typeof callback === 'function') callback()
        return
      }
      try {
        await super.destroy()
        await adapter.destroy()
        if (typeof callback === 'function') callback()
      } catch (err) {
        if (typeof callback === 'function') return callback(err)
        throw err
      }
    }
  }

  // sqlite3's own constructor warns (see the module comment above) unless
  // `connection.filename` and `useNullAsDefault` are already set. `filename`
  // is never opened — `adapter` owns the real connection — and
  // `useNullAsDefault: true` is standard, harmless knex practice regardless.
  const dialectDefaults: Record<string, unknown> = adapter.dialect === 'sqlite' ? { useNullAsDefault: true } : {}
  // ':memory:' satisfies the check above only — knex never actually opens
  // it, since `adapter` (not knex) owns the connection.
  const connectionDefault: Record<string, unknown> = adapter.dialect === 'sqlite' ? { filename: ':memory:' } : {}

  // Overrides knex's inherited pool default (`min: 2, max: 10`). This
  // library's documented usage pattern is a fresh client per request, never
  // one cached in a module-level global — Hyperdrive already pools
  // server-side, and reusing a cached knex/socket object across requests
  // throws workerd's "Cannot perform I/O on behalf of a different request".
  // tarn only ever creates connections to satisfy actual pending acquires
  // (`_shouldCreateMoreResources`, node_modules/.pnpm/tarn@3.1.2's
  // Pool.js), so `min: 2` does NOT mean two connections open eagerly up
  // front — a single query against a `min: 2` pool still opens exactly one.
  // The real problem is what happens to that one connection afterward: it
  // is never reclaimed. tarn's reap arithmetic (`maxDestroy = free.length -
  // (min - used.length)`, from the same `check()`) is ≤ 0 whenever at most
  // `min` connections are sitting idle, so the idle-timeout reaper never
  // fires on them. With a fresh client per request and `min: 2`, the one
  // connection that request's query opened is pinned open for the rest of
  // that client's lifetime instead of being reclaimable — exactly backwards
  // for a client that's about to be destroyed at the end of the request
  // anyway. `min: 0` removes that floor entirely, so an idle connection is
  // always eligible for reaping; `max: 5` is a modest per-client ceiling,
  // not a promise every adapter/database combination can sustain
  // concurrently.
  const poolDefault: Record<string, unknown> = { pool: { min: 0, max: 5 } }

  // `client` must always be `CfKnexClient` (a caller-supplied one would
  // defeat this function), and `connection`/`log` must merge with their
  // defaults rather than replace them (an incomplete caller `connection`
  // would otherwise reintroduce the sqlite crash above) — handled
  // explicitly below rather than by spread order. `pool` and everything
  // else override freely: a caller-supplied `pool` (already passed through
  // via this same `restOptions` spread today) fully replaces `poolDefault`
  // above it, exactly like `dialectDefaults`.
  const { connection: callerConnection, log: callerLog, ...restOptions } = knexOptions as Record<string, unknown> & {
    connection?: Record<string, unknown>
    log?: Record<string, unknown>
  }

  return Knex({
    ...dialectDefaults,
    ...poolDefault,
    ...restOptions,
    connection: { ...connectionDefault, ...callerConnection },
    log: { ...DEFAULT_LOG, ...callerLog },
    client: CfKnexClient as unknown as typeof KnexType.Client,
  }) as KnexType<TRecord, TResult>
}
