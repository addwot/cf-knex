import type { Dialect, DriverAdapter, RawResult } from '../../src/core/types'

export function createFakeAdapter(opts: { dialect: Dialect; result?: Partial<RawResult> }) {
  const calls: Array<{ sql: string; bindings: unknown[] }> = []
  const adapter: DriverAdapter = {
    dialect: opts.dialect,
    driver: 'mysql2',
    capabilities: { streaming: false, transactions: true },
    acquire: async () => ({}),
    release: async () => {},
    execute: async (_h, sql, bindings) => {
      calls.push({ sql, bindings })
      return { rows: [], ...opts.result } as RawResult
    },
    destroy: async () => {},
  }
  return { adapter, calls }
}
