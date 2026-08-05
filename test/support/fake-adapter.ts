import type { Dialect, DriverAdapter, RawResult } from '../../src/core/types'

export function createFakeAdapter(opts: { dialect: Dialect; result?: Partial<RawResult> }) {
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
  const adapter: DriverAdapter = {
    dialect: opts.dialect,
    driver: 'mysql2',
    capabilities: { streaming: false, transactions: true },
    acquire: async () => {
      acquireCount++
      const handle = {}
      handles.push(handle)
      return handle
    },
    release: async (handle) => {
      released.add(handle)
    },
    execute: async (_h, sql, bindings) => {
      calls.push({ sql, bindings })
      return { rows: [], ...opts.result } as RawResult
    },
    destroy: async () => {
      destroyCount++
    },
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
