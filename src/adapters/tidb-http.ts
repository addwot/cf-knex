import { CfKnexError } from '../core/errors'
import type { DriverAdapter, RawResult } from '../core/types'
import type { FullResult } from '@tidbcloud/serverless'

type Isolation = 'READ COMMITTED' | 'REPEATABLE READ'

type TidbConnection = {
  execute(query: string, args: unknown[], options: { fullResult: true }): Promise<FullResult>
  begin(txOptions?: { isolation?: Isolation }): Promise<TidbTx>
}

type TidbTx = {
  execute(query: string, args: unknown[], options: { fullResult: true }): Promise<FullResult>
  rollback(): Promise<unknown>
  conn?: { session?: string | null }
}

function sessionOf(tx: TidbTx): string | null | undefined {
  return tx.conn?.session
}

export type TidbHttpAdapterOptions = {
  url: string
  timeoutMs?: number
  fetch?: typeof fetch
}

export function resolveFetch(opts: TidbHttpAdapterOptions): typeof fetch {
  const base = opts.fetch ?? fetch
  const ms = opts.timeoutMs
  if (ms === undefined) return base
  return async (input, init) => {
    const budget = AbortSignal.timeout(ms)
    const signal = init?.signal ? AbortSignal.any([init.signal, budget]) : budget
    const expired = new Promise<never>((_, reject) => {
      budget.addEventListener('abort', () => reject(CfKnexError.requestTimedOut('tidb-http', ms)), { once: true })
    })
    try {
      return await Promise.race([base(input, { ...init, signal }), expired])
    } catch (err) {
      if (budget.aborted) throw CfKnexError.requestTimedOut('tidb-http', ms)
      throw err
    }
  }
}

type TxState = { tx?: TidbTx; session?: string | null; pendingIsolation?: Isolation; tail?: Promise<void> }

function enqueue<T>(state: TxState, job: () => Promise<T>): Promise<T> {
  const run = (state.tail ?? Promise.resolve()).then(job)
  state.tail = run.then(NOOP, NOOP)
  return run
}

function NOOP(): void {}

function assertSameSession(expected: string | null | undefined, tx: TidbTx, sql: string): void {
  if (expected === undefined || expected === null) return
  const actual = sessionOf(tx)
  if (actual === undefined || actual === expected) return
  throw CfKnexError.transactionEscaped(
    `the TiDB session changed while running ${describeStatement(sql)}, so the server ran it in autocommit rather than in this transaction. This is a TiDB Cloud Serverless HTTP behaviour, not a query error; retry the whole transaction.`,
  )
}

function describeStatement(sql: string): string {
  const verb = /^\s*([A-Za-z]+)/.exec(sql)?.[1]?.toUpperCase()
  if (!verb) return 'a statement'
  return `${/^[AEIOU]/.test(verb) ? 'an' : 'a'} ${verb} statement`
}

export function createTidbHttpAdapter(opts: TidbHttpAdapterOptions): DriverAdapter {
  const txStates = new WeakMap<TidbConnection, TxState>()
  const request = resolveFetch(opts)

  return {
    dialect: 'mysql',
    driver: 'tidb-http',
    capabilities: { streaming: false, transactions: true },

    async acquire(): Promise<TidbConnection> {
      let serverless: typeof import('@tidbcloud/serverless')
      try {
        serverless = await import('@tidbcloud/serverless')
      } catch {
        throw CfKnexError.missingDriver('@tidbcloud/serverless')
      }
      return serverless.connect({ url: opts.url, fetch: request }) as unknown as TidbConnection
    },

    async release(handle: unknown): Promise<void> {
      const conn = handle as TidbConnection
      const state = txStates.get(conn)
      txStates.delete(conn)
      if (state?.tx) await state.tx.rollback().catch(() => {})
    },

    async execute(handle, sql, bindings): Promise<RawResult> {
      const conn = handle as TidbConnection
      const state = txStates.get(conn)

      if (state?.tx) {
        const { tx } = state
        return enqueue(state, async () => {
          if (COMMIT_STATEMENT.test(sql) || ROLLBACK_STATEMENT.test(sql)) {
            try {
              const ended = toRawResult(await tx.execute(sql, bindings, { fullResult: true }))
              assertSameSession(state.session, tx, sql)
              return ended
            } finally {
              txStates.delete(conn)
            }
          }
          const result = toRawResult(await tx.execute(sql, bindings, { fullResult: true }))
          try {
            assertSameSession(state.session, tx, sql)
          } catch (err) {
            txStates.delete(conn)
            throw err
          }
          return result
        })
      }

      if (BEGIN_STATEMENT.test(sql)) {
        const isolation = state?.pendingIsolation
        txStates.delete(conn)
        const tx = await conn.begin(isolation ? { isolation } : undefined)
        txStates.set(conn, { tx, session: sessionOf(tx) })
        return { rows: [] }
      }

      const setTransaction = SET_TRANSACTION_STATEMENT.exec(sql)
      if (setTransaction) {
        txStates.set(conn, { pendingIsolation: parseIsolationLevel(setTransaction[1] ?? '') })
        return { rows: [] }
      }

      if (state) txStates.delete(conn)

      const result: unknown = await conn.execute(sql, bindings, { fullResult: true })
      return toRawResult(result)
    },

    async destroy(): Promise<void> {},
  }
}

function toRawResult(result: unknown): RawResult {
  if (result === null || typeof result !== 'object' || Array.isArray(result) || !('rows' in result)) {
    throw CfKnexError.malformedResult(
      `tidb-http query did not return a fullResult object with a 'rows' field (got ${Array.isArray(result) ? 'an array' : result === null ? 'null' : typeof result})`,
    )
  }
  const rows = (result as { rows: unknown }).rows
  if (!(Array.isArray(rows) || rows === null)) {
    throw CfKnexError.malformedResult(`tidb-http query's 'rows' was neither an array nor null (got ${typeof rows})`)
  }

  const full = result as Partial<FullResult>
  return {
    rows: full.rows ?? [],
    insertId: normalizeInsertId(full.lastInsertId),
    affectedRows: normalizeAffectedRows(full.rowsAffected),
  }
}

function normalizeInsertId(id: string | number | null | undefined): bigint | number | undefined {
  if (id === null || id === undefined) return undefined
  if (typeof id === 'number') return id
  if (!/^\d+$/.test(id)) {
    throw CfKnexError.malformedResult(`tidb-http lastInsertId was not a numeric string (got ${JSON.stringify(id)})`)
  }
  return BigInt(id)
}

function normalizeAffectedRows(value: number | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'number') {
    throw CfKnexError.malformedResult(`tidb-http rowsAffected was not a number (got ${typeof value})`)
  }
  return value
}

const BEGIN_STATEMENT = /^(?:BEGIN|START\s+TRANSACTION)\s*;?\s*$/i
const COMMIT_STATEMENT = /^COMMIT\s*;?\s*$/i
const ROLLBACK_STATEMENT = /^ROLLBACK\s*;?\s*$/i
const SET_TRANSACTION_STATEMENT = /^SET\s+TRANSACTION\s+(.+?)\s*;?\s*$/i

function parseIsolationLevel(mode: string): Isolation {
  if (/READ\s+ONLY/i.test(mode)) {
    throw CfKnexError.unsupportedTransactionMode(
      "'SET TRANSACTION READ ONLY' has no equivalent in the tidb-http driver — the transaction that follows would silently open read/write instead of read-only.",
    )
  }
  const level = mode.replace(/^ISOLATION\s+LEVEL\s+/i, '').trim().toUpperCase().replace(/\s+/g, ' ')
  if (level === 'READ COMMITTED' || level === 'REPEATABLE READ') return level
  throw CfKnexError.unsupportedTransactionMode(
    `isolation level '${mode.trim()}' is not supported by the tidb-http driver — only 'READ COMMITTED' and 'REPEATABLE READ' are.`,
  )
}
