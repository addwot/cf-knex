import type { AdapterCapabilities, Dialect, DriverAdapter, RawResult } from '../../src/core/types'

export function createFakeAdapter(opts: {
  dialect: Dialect
  result?: Partial<RawResult>
  // Opts a fake handle into going "stale" the moment it's used once, so a
  // test can exercise the pool-eviction path `DriverAdapter.validate` exists
  // for (src/core/types.ts) without a real database: tarn calls `validate`
  // before handing a pooled handle back out, so a query run against a
  // handle this flipped stale should force a fresh `acquire()` instead of
  // reusing it. Omitted entirely (not just `undefined`) unless this is set,
  // matching every other fake adapter in this file — a `DriverAdapter`
  // without `validate` at all is "always valid", the default every adapter
  // that can't go stale (tidb-http, d1) actually needs; adding it always,
  // even as a no-op true, would stop that default path from being the one
  // every other test in this suite exercises.
  invalidateAfterFirstUse?: boolean
  // Merged over the default `{ streaming: false, transactions: true }`
  // rather than replacing it outright, so a test that only cares about one
  // flag (e.g. asserting `createKnexClient` rejects `db.transaction()` when
  // an adapter declares `capabilities.transactions: false`) doesn't have to
  // restate the other.
  capabilities?: Partial<AdapterCapabilities>
}) {
  const calls: Array<{ sql: string; bindings: unknown[] }> = []
  // `createKnexClient` (src/core/client.ts) wires `acquire`/`release`/
  // `destroy` into knex's real tarn pool now, rather than calling into them
  // once per query — so, unlike `calls` above, these three fire on
  // whatever schedule tarn chooses (lazily, on demand, and not necessarily
  // once per handle handed out). `released` is keyed on the handle itself
  // so a test can assert a *specific* acquired handle was released, not
  // just that release fired some number of times.
  let acquireCount = 0
  let destroyCount = 0
  const released = new Set<unknown>()
  const handles: object[] = []
  const usedOnce = new Set<unknown>()
  const adapter: DriverAdapter = {
    dialect: opts.dialect,
    driver: 'mysql2',
    capabilities: { streaming: false, transactions: true, ...opts.capabilities },
    acquire: async () => {
      acquireCount++
      const handle = {}
      handles.push(handle)
      return handle
    },
    release: async (handle) => {
      released.add(handle)
    },
    execute: async (h, sql, bindings) => {
      calls.push({ sql, bindings })
      usedOnce.add(h)
      return { rows: [], ...opts.result } as RawResult
    },
    destroy: async () => {
      destroyCount++
    },
  }
  if (opts.invalidateAfterFirstUse) {
    adapter.validate = (handle: unknown) => !usedOnce.has(handle)
  }
  return {
    adapter,
    calls,
    acquireCount: () => acquireCount,
    destroyCount: () => destroyCount,
    handles,
    wasReleased: (handle: unknown) => released.has(handle),
  }
}
