import { CfKnexError } from '../core/errors'
import type { DriverAdapter, RawResult } from '../core/types'
import type { Client, InArgs, IntMode, ResultSet, Transaction, TransactionMode } from '@libsql/client'

export type LibsqlAdapterOptions = { url: string; authToken?: string; intMode?: IntMode }

export function createLibsqlAdapter(opts: LibsqlAdapterOptions): DriverAdapter {
  const open = new Set<Client>()

  const activeTx = new WeakMap<Client, Transaction>()
  const pendingMode = new WeakMap<Client, TransactionMode>()

  async function abandonTransaction(client: Client): Promise<void> {
    const tx = activeTx.get(client)
    if (!tx) return
    activeTx.delete(client)
    pendingMode.delete(client)
    await tx.rollback().catch(() => {})
  }

  return {
    dialect: 'sqlite',
    driver: 'libsql',
    capabilities: { streaming: false, transactions: true },

    async acquire(): Promise<Client> {
      let mod: typeof import('@libsql/client')
      try {
        mod = await import('@libsql/client')
      } catch {
        throw CfKnexError.missingDriver('@libsql/client')
      }
      const client = mod.createClient({ url: opts.url, authToken: opts.authToken, intMode: opts.intMode })
      open.add(client)
      return client
    },

    async release(handle: unknown): Promise<void> {
      const client = handle as Client
      open.delete(client)
      await abandonTransaction(client)
      client.close()
    },

    async execute(handle, sql, bindings): Promise<RawResult> {
      const client = handle as Client
      const tx = activeTx.get(client)

      if (tx) {
        if (COMMIT_STATEMENT.test(sql)) {
          activeTx.delete(client)
          await tx.commit()
          return EMPTY_RESULT
        }
        if (ROLLBACK_STATEMENT.test(sql)) {
          activeTx.delete(client)
          await tx.rollback()
          return EMPTY_RESULT
        }
        return toRawResult(await tx.execute({ sql, args: bindings as unknown as InArgs }))
      }

      if (BEGIN_STATEMENT.test(sql)) {
        const mode = pendingMode.get(client) ?? 'write'
        pendingMode.delete(client)
        activeTx.set(client, await client.transaction(mode))
        return EMPTY_RESULT
      }

      const setTransaction = SET_TRANSACTION_STATEMENT.exec(sql)
      const trxMode = setTransaction?.[1] ?? ''
      if (setTransaction) {
        const isolation = ISOLATION_LEVEL.exec(trxMode)
        if (isolation) {
          throw CfKnexError.unsupportedTransactionMode(
            `isolation level '${isolation[1] ?? trxMode}' is not configurable on the libsql driver — SQLite is always serializable. Omit isolationLevel for this driver.`,
          )
        }
        if (READ_ONLY_STATEMENT.test(trxMode)) {
          pendingMode.set(client, 'read')
          return EMPTY_RESULT
        }
      }

      pendingMode.delete(client)

      return toRawResult(await client.execute({ sql, args: bindings as unknown as InArgs }))
    },

    async destroy(): Promise<void> {
      for (const client of open) {
        await abandonTransaction(client)
        client.close()
      }
      open.clear()
    },
  }
}

function toRawResult(res: unknown): RawResult {
  if (res === null || typeof res !== 'object' || !('rows' in res)) {
    throw CfKnexError.malformedResult(
      `libsql execute() did not return a ResultSet with a 'rows' field (got ${res === null ? 'null' : typeof res})`,
    )
  }
  const { rows, columns, rowsAffected, lastInsertRowid } = res as Partial<ResultSet>
  if (!Array.isArray(rows)) {
    throw CfKnexError.malformedResult(`libsql ResultSet.rows was not an array (got ${typeof rows})`)
  }
  if (typeof rowsAffected !== 'number') {
    throw CfKnexError.malformedResult(`libsql ResultSet.rowsAffected was not a number (got ${typeof rowsAffected})`)
  }
  if (lastInsertRowid !== undefined && typeof lastInsertRowid !== 'bigint') {
    throw CfKnexError.malformedResult(
      `libsql ResultSet.lastInsertRowid was neither bigint nor undefined (got ${typeof lastInsertRowid})`,
    )
  }
  return {
    rows,
    fields: columns,
    insertId: lastInsertRowid,
    affectedRows: rowsAffected,
  }
}

const BEGIN_STATEMENT = /^(?:BEGIN|START\s+TRANSACTION)\s*;?\s*$/i
const COMMIT_STATEMENT = /^COMMIT\s*;?\s*$/i
const ROLLBACK_STATEMENT = /^ROLLBACK\s*;?\s*$/i
const SET_TRANSACTION_STATEMENT = /^SET\s+TRANSACTION\s+(.+?)\s*;?\s*$/i
const ISOLATION_LEVEL = /ISOLATION\s+LEVEL\s+(READ\s+UNCOMMITTED|READ\s+COMMITTED|REPEATABLE\s+READ|SERIALIZABLE|SNAPSHOT)/i
const READ_ONLY_STATEMENT = /READ\s+ONLY/i

const EMPTY_RESULT: RawResult = { rows: [] }
