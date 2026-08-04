import Knex from 'knex'
import type { Knex as KnexType } from 'knex'
// These deep CJS dialect paths have no shipped type declarations (knex only
// types its public entry point) — ambient module declarations for them live
// in ./knex-dialects.d.ts.
import Client_MySQL2 from 'knex/lib/dialects/mysql2'
import Client_PG from 'knex/lib/dialects/postgres'
import Client_SQLite3 from 'knex/lib/dialects/sqlite3'
// Side-effect-only. See the long comment below `DIALECT_CLASSES` — this
// import is a partial, unverified mitigation for a bundling gap we could not
// close from within this file; it is not a confirmed fix, unlike the rest of
// this module.
import 'knex/lib/logger'
import { CfKnexError } from './errors'
import { toKnexResponse } from './response'
import type { Dialect, DriverAdapter } from './types'

// Static imports, not `createRequire`, for the three dialect classes below:
// `createRequire`-loading them at runtime happens outside Vite's module
// graph, so Vite cannot pre-bundle their dependencies at all — e.g. the real
// native driver package (mysql2/pg/sqlite3) that `initializeDriver()` (see
// below) used to reach for, which cannot load in workerd regardless of how
// it's required, but which used to fail with an opaque low-level resolution
// error instead of surfacing cleanly through `loadDialect`'s own guard.
// Static imports read as a constructor the same way `createRequire` did, are
// simpler, and drop the `node:module` dependency (createRequire needed a
// hand-written ambient type declaration for it; see the removed
// src/core/node-module.d.ts in git history).
//
// What static imports do *not* fix, despite an earlier attempt to claim
// otherwise here: knex's `Logger` colors every warn/error/deprecate message
// via `colorette` (node_modules/knex/lib/logger.js), and the specific
// `Logger` instance a dialect class uses internally — created inside knex's
// base `Client` constructor via its own `require('../../client')` ->
// `require('./logger')` chain — still fails to resolve `colorette` inside
// this project's vitest-pool-workers test harness, exactly as it did before
// this file switched away from `createRequire`. Verified directly: a
// `Logger` instance obtained via a top-level `import Logger from
// 'knex/lib/logger'` calls `.warn()` without throwing, but
// `new Client_SQLite3({ client: 'sqlite3', connection: {} })` — which
// reaches `colorette` through the dialect's own internal chain, not this
// file's imports — still throws `Cannot read properties of undefined
// (reading 'red')` at construction, import order notwithstanding. This is a
// Vite/esbuild dependency pre-bundling gap for third-party sub-dependencies
// reached transitively through an already-bundled entry's own relative-path
// requires, not something `createKnexClient` can route around by importing
// more of knex's internals — the module instance the dialect class actually
// uses is simply a different, non-deduplicated copy from the one any import
// in this file reaches. The `import 'knex/lib/logger'` above does not fix
// this (confirmed: removing it changes nothing observable); it is left in
// only because it is harmless and might matter under a real bundler.
//
// What actually keeps this working today is not fixing `colorette` at all,
// but not calling into the broken path: `initializeDriver()` below is
// no-op'd so knex's own error-reporting `this.logger.error(...)` call for a
// failed native-driver require never fires, and the sqlite3 dialect's own
// two unconditional constructor-time `this.logger.warn(...)` calls are
// avoided by satisfying the config checks that gate them (see
// `dialectDefaults` below) rather than by making the warn calls themselves
// safe to make.
const DIALECT_CLASSES: Record<Dialect, unknown> = {
  mysql: Client_MySQL2,
  postgres: Client_PG,
  sqlite: Client_SQLite3,
}

function loadDialect(dialect: Dialect): new (...args: never[]) => unknown {
  const Base = DIALECT_CLASSES[dialect]
  // Runtime guard, kept even though the import above would already fail to
  // resolve if these paths disappeared: a future knex version could keep the
  // path resolvable while changing what it exports (e.g. a named export
  // instead of a default), which `import` alone wouldn't catch as clearly as
  // this explicit, on-brand `CfKnexError`.
  if (typeof Base !== 'function') {
    throw new CfKnexError('INCOMPATIBLE_KNEX', `'knex/lib/dialects' entry for '${dialect}' did not export a constructor`)
  }
  return Base as new (...args: never[]) => unknown
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- mirrors knex's own public `Knex<TRecord, TResult>` signature (node_modules/knex/types/index.d.ts); widening it would diverge from knex's generics and break `.select()`/`.selec()` type-checking.
export function createKnexClient<TRecord extends {} = any, TResult = unknown[]>(
  adapter: DriverAdapter,
  knexOptions: Record<string, unknown> = {},
): KnexType<TRecord, TResult> {
  const Base = loadDialect(adapter.dialect) as new (...args: never[]) => Record<string, unknown>

  class CfKnexClient extends Base {
    // knex's base Client constructor unconditionally calls this whenever
    // `config.connection` is truthy (see node_modules/knex/lib/client.js).
    // The dialect implementation tries to `require()` the real native driver
    // package (mysql2/pg/sqlite3) — a genuinely different module from the
    // dialect class itself, and one we have no reason to load: real driver
    // packages open real sockets/files, which don't exist in workerd, and
    // are unnecessary anyway since `adapter` supplies connections instead.
    // Every method that would otherwise consult `this.driver`
    // (acquireConnection/releaseConnection/_query) is overridden below and
    // never touches it, so no-opping this is safe.
    initializeDriver() {}

    async acquireConnection() {
      return adapter.acquire()
    }

    async releaseConnection(handle: unknown) {
      await adapter.release(handle)
    }

    async _query(handle: unknown, obj: Record<string, unknown>) {
      const raw = await adapter.execute(handle, obj.sql as string, (obj.bindings as unknown[]) ?? [])
      return toKnexResponse(adapter.dialect, raw, obj)
    }

    _stream() {
      throw CfKnexError.unsupported(adapter.driver, 'streaming', 'Use .limit()/.offset() to paginate.')
    }
  }

  // The sqlite3 dialect's own constructor (node_modules/knex/lib/dialects/sqlite3/index.js)
  // warns twice unless `connection.filename` and `useNullAsDefault` are
  // already set — real advice for real sqlite3 users, who do need a file
  // path and do need to know sqlite can't insert bare DEFAULT values. Neither
  // applies to us: `adapter`, not knex, owns the actual connection, so knex
  // never opens a file and `filename` exists solely to satisfy that check;
  // `useNullAsDefault: true` is standard, harmless knex practice for sqlite
  // regardless. This is load-bearing, not just tidy: as explained in the
  // long comment above `DIALECT_CLASSES`, those warn calls still crash in
  // this test harness (a colorette bundling gap, unrelated to
  // createRequire), so defaulting both away — skipping the calls entirely —
  // is what actually keeps sqlite construction from throwing, not any fix to
  // the warn path itself.
  const dialectDefaults: Record<string, unknown> =
    adapter.dialect === 'sqlite' ? { connection: { filename: ':memory:' }, useNullAsDefault: true } : { connection: {} }

  return Knex({
    client: CfKnexClient as unknown as typeof KnexType.Client,
    ...dialectDefaults,
    // Route knex's own warn/error/deprecate output through plain console
    // methods so it lands in the Workers log viewer without the ANSI color
    // codes colorette would otherwise emit — meaningless noise there, since
    // there's no TTY to render them.
    log: {
      warn: (message: string) => console.warn(message),
      error: (message: string) => console.error(message),
      deprecate: (message: string) => console.warn(message),
    },
    ...knexOptions,
  }) as KnexType<TRecord, TResult>
}
