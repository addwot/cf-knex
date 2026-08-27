import { CfKnexError } from '../core/errors'
import type { DriverAdapter, RawResult } from '../core/types'

type D1PreparedStatementLike = {
  bind(...values: unknown[]): D1PreparedStatementLike
  all(): Promise<unknown>
}

type D1DatabaseLike = {
  prepare(query: string): D1PreparedStatementLike
}

export type D1AdapterOptions = { binding: D1DatabaseLike }

export function createD1Adapter(opts: D1AdapterOptions): DriverAdapter {
  return {
    dialect: 'sqlite',
    driver: 'd1',
    capabilities: { streaming: false, transactions: false },

    hints: {
      transactions:
        "D1 has no interactive transaction session (no BEGIN/COMMIT/ROLLBACK) -- use the binding's own batch() " +
        'to submit multiple statements as one atomic unit instead: they either all commit or none do, without ' +
        'holding an open session between them the way an interactive transaction would.',
    },

    async acquire(): Promise<D1DatabaseLike> {
      return { prepare: (query: string) => opts.binding.prepare(query) }
    },

    async release(): Promise<void> {},

    async execute(handle, sql, bindings): Promise<RawResult> {
      const db = handle as D1DatabaseLike
      const result = await db.prepare(sql).bind(...bindings).all()
      return toRawResult(result)
    },

    async destroy(): Promise<void> {},
  }
}

function toRawResult(result: unknown): RawResult {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    throw CfKnexError.malformedResult(
      `d1 query did not return a D1Result object (got ${Array.isArray(result) ? 'an array' : result === null ? 'null' : typeof result})`,
    )
  }

  const { results, meta } = result as { results?: unknown; meta?: unknown }

  if (!Array.isArray(results)) {
    throw CfKnexError.malformedResult(`d1 query's 'results' was not an array (got ${typeof results})`)
  }
  if (meta === null || typeof meta !== 'object') {
    throw CfKnexError.malformedResult(`d1 query's 'meta' was not an object (got ${meta === null ? 'null' : typeof meta})`)
  }

  const { last_row_id: lastRowId, changes } = meta as { last_row_id?: unknown; changes?: unknown }
  if (typeof lastRowId !== 'number') {
    throw CfKnexError.malformedResult(`d1 query's 'meta.last_row_id' was not a number (got ${typeof lastRowId})`)
  }
  if (typeof changes !== 'number') {
    throw CfKnexError.malformedResult(`d1 query's 'meta.changes' was not a number (got ${typeof changes})`)
  }

  return { rows: results, insertId: lastRowId, affectedRows: changes }
}
