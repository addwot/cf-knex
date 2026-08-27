import { CfKnexError } from '../core/errors'
import type { Credentials, DriverAdapter, RawResult } from '../core/types'

type PgClientShim = {
  connect(): Promise<void>
  query(sql: string, values?: unknown[]): Promise<PgResult>
  end(): Promise<void>
  on(event: 'error', listener: (err: Error) => void): void
}

type PgClientInternals = {
  _queryable: boolean
  _ending: boolean
  _ended: boolean
}

type PgResult = {
  command?: unknown
  rowCount?: unknown
  rows: unknown[]
  fields?: unknown[]
}

type HyperdriveConfig = { connectionString: string }

export type PgAdapterOptions = {
  url?: string
  connection?: Credentials
  hyperdrive?: HyperdriveConfig
}

export function resolveConfig(opts: PgAdapterOptions): Record<string, unknown> {
  if (opts.hyperdrive) {
    const { connectionString } = opts.hyperdrive
    return { connectionString }
  }
  if (opts.connection) {
    // `ssl` passes through untranslated, unlike src/adapters/mysql2.ts: pg accepts a bare
    // boolean, and rewriting it would discard a caller's own `{ rejectUnauthorized }` object.
    return { ...opts.connection }
  }
  if (opts.url) return { connectionString: opts.url }
  throw new CfKnexError('NO_CONNECTION', "pg adapter needs one of 'url', 'connection' or 'hyperdrive'")
}

const FETCH_BATCH_SIZE = 100

export function createPgAdapter(opts: PgAdapterOptions): DriverAdapter {
  const config = resolveConfig(opts)

  const open = new Set<PgClientShim>()

  let cursorSeq = 0

  // A count, not a Set: two overlapping unawaited `stream()` calls on one handle would
  // collapse to a single entry and clear it while the second was still tearing down.
  const handlesMidTeardown = new Map<PgClientShim, number>()

  function markMidTeardown(client: PgClientShim): void {
    handlesMidTeardown.set(client, (handlesMidTeardown.get(client) ?? 0) + 1)
  }

  function unmarkMidTeardown(client: PgClientShim): void {
    const next = (handlesMidTeardown.get(client) ?? 0) - 1
    if (next <= 0) handlesMidTeardown.delete(client)
    else handlesMidTeardown.set(client, next)
  }

  return {
    dialect: 'postgres',
    driver: 'pg',
    capabilities: { streaming: true, transactions: true },

    async acquire(): Promise<PgClientShim> {
      let pgDefault: { Client: unknown }
      try {
        pgDefault = (await import('pg')).default
      } catch {
        throw CfKnexError.missingDriver('pg')
      }
      const PgClient = pgDefault.Client as unknown as new (config: unknown) => PgClientShim
      const client = new PgClient(config)
      await client.connect()
      open.add(client)
      client.on('error', () => {})
      return client
    },

    async release(handle: unknown): Promise<void> {
      const client = handle as PgClientShim
      open.delete(client)
      handlesMidTeardown.delete(client)
      await client.end()
    },

    validate(handle: unknown): boolean {
      const client = handle as unknown as PgClientInternals
      return client._queryable && !client._ending && !client._ended && !handlesMidTeardown.has(handle as PgClientShim)
    },

    async execute(handle, sql, bindings): Promise<RawResult> {
      const client = handle as PgClientShim
      const res = await client.query(sql, bindings)
      const result = toRawResult(res)
      if (isCommitStatement(sql) && result.command === 'ROLLBACK') {
        throw CfKnexError.commitSilentlyRolledBack(
          "the transaction's own work may be partially or entirely lost — an earlier statement on this connection failed and its error was caught instead of propagating, leaving the transaction aborted; find and fix that statement. Nothing can recover the work at this point: postgres rejects every statement on an aborted transaction with 25P02, including a retry. To let a statement fail without destroying the transaction, run it inside a nested transaction (`await trx.transaction(async sp => …)`), which postgres can roll back to.",
        )
      }
      return result
    },

    async *stream(handle, sql, bindings) {
      const client = handle as PgClientShim
      const marker = `cf_knex_sp_${++cursorSeq}`
      const cursorName = `cf_knex_cur_${cursorSeq}`

      markMidTeardown(client)
      try {
        let nested: boolean
        try {
          await client.query(`SAVEPOINT ${marker}`)
          nested = true
        } catch (err) {
          // SQLSTATE 25P01 is "no active transaction", so a rejected SAVEPOINT is how this
          // stream learns it must open its own rather than nest inside a caller's.
          if ((err as { code?: string }).code !== '25P01') throw err
          nested = false
          await client.query('BEGIN')
          await client.query(`SAVEPOINT ${marker}`)
        }

        let cursorOpen = false
        let failed = false
        let completed = false
        try {
          await client.query(`DECLARE ${cursorName} CURSOR FOR ${sql}`, bindings)
          cursorOpen = true
          for (;;) {
            const res = await client.query(`FETCH ${FETCH_BATCH_SIZE} FROM ${cursorName}`)
            if (res.rows.length === 0) break
            yield* res.rows
          }
          completed = true
        } catch (err) {
          failed = true
          throw err
        } finally {
          if (cursorOpen) await client.query(`CLOSE ${cursorName}`).catch(() => {})
          if (failed) {
            // `RELEASE SAVEPOINT` is deliberately never issued: releasing an outer savepoint
            // cascades into an overlapping stream's inner one (SQLSTATE 3B001), and postgres
            // reclaims them on the outer COMMIT/ROLLBACK anyway.
            await client.query(`ROLLBACK TO SAVEPOINT ${marker}`).catch(() => {})
            if (!nested) await client.query('ROLLBACK').catch(() => {})
          } else if (completed) {
            if (!nested) await client.query('COMMIT')
          } else {
            // Best-effort, unlike the branch above: the consumer walked away mid-stream, so a
            // failed COMMIT has no caller left to raise it to.
            if (!nested) await client.query('COMMIT').catch(() => {})
          }
        }
      } finally {
        unmarkMidTeardown(client)
      }
    },

    async destroy(): Promise<void> {
      await Promise.all([...open].map((client) => client.end()))
      open.clear()
      handlesMidTeardown.clear()
    },
  }
}

function toRawResult(res: unknown): RawResult {
  if (res === null || typeof res !== 'object' || !Array.isArray((res as { rows?: unknown }).rows)) {
    throw CfKnexError.malformedResult(
      `pg query did not return a Result with a 'rows' array (got ${res === null ? 'null' : typeof res})`,
    )
  }
  const result = res as PgResult
  if (typeof result.command !== 'string' || result.command.length === 0) {
    throw CfKnexError.malformedResult(`pg query result had no 'command' string (got ${typeof result.command})`)
  }
  return {
    rows: result.rows,
    fields: result.fields ?? [],
    command: result.command,
    affectedRows: typeof result.rowCount === 'number' ? result.rowCount : undefined,
  }
}

const COMMIT_STATEMENT = /^(?:COMMIT|END)(?:\s+AND\s+CHAIN)?\s*;?\s*$/i

function isCommitStatement(sql: string): boolean {
  return COMMIT_STATEMENT.test(sql)
}
