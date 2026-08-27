import { CfKnexError } from '../core/errors'
import type { Credentials, DriverAdapter, RawResult } from '../core/types'
import type { Connection, ConnectionOptions, FieldPacket, QueryResult, QueryValues } from 'mysql2/promise'

type Mysql2ConnectionShim = {
  query(sql: string, values?: QueryValues): Promise<[QueryResult, FieldPacket[]]>
  on(event: 'error', listener: (err: Error) => void): void
}

type RawMysql2Connection = {
  _fatalError: unknown
  _protocolError: unknown
  _closing: boolean
  stream: { destroyed: boolean }
  query(sql: string, values: unknown[]): { stream(): AsyncIterable<unknown> }
}

type HyperdriveConfig = {
  host: string
  port: number
  user: string
  password: string
  database: string
}

export type Mysql2AdapterOptions = {
  url?: string
  connection?: Credentials
  hyperdrive?: HyperdriveConfig
}

function credentialsToConnectionOptions(creds: Credentials): ConnectionOptions {
  const { ssl, ...rest } = creds
  return {
    ...rest,
    ...(ssl ? { ssl: {} } : {}),
  }
}

function resolveConnectionOptions(opts: Mysql2AdapterOptions): ConnectionOptions {
  if (opts.hyperdrive) {
    const { host, port, user, password, database } = opts.hyperdrive
    return { host, port, user, password, database }
  }
  if (opts.connection) return credentialsToConnectionOptions(opts.connection)
  if (opts.url) return { uri: opts.url }
  throw new CfKnexError('NO_CONNECTION', "mysql2 adapter needs one of 'url', 'connection' or 'hyperdrive'")
}

function ensureMessage(err: unknown): unknown {
  if (!(err instanceof Error) || err.message !== '') return err
  const { code, errno, sqlState, sqlMessage } = err as Error & {
    code?: unknown
    errno?: unknown
    sqlState?: unknown
    sqlMessage?: unknown
  }
  const fields = Object.entries({ code, errno, sqlState, sqlMessage })
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${String(v)}`)
  // Mutated in place rather than replaced with a new Error, which would drop the driver's own
  // `code`/`errno`/`sqlState` and change identity for anything already holding the original.
  if (fields.length > 0) err.message = `mysql2 error with empty message (${fields.join(', ')})`
  return err
}

export function createMysql2Adapter(opts: Mysql2AdapterOptions): DriverAdapter {
  const config: ConnectionOptions = { ...resolveConnectionOptions(opts), disableEval: true }

  const open = new Set<Connection>()

  const dead = new WeakSet<Connection>()

  return {
    dialect: 'mysql',
    driver: 'mysql2',
    capabilities: { streaming: true, transactions: true },

    async acquire(): Promise<Connection> {
      let mysql: typeof import('mysql2/promise')
      try {
        mysql = await import('mysql2/promise')
      } catch {
        throw CfKnexError.missingDriver('mysql2')
      }
      const conn = await mysql.createConnection(config).catch((err: unknown) => {
        throw ensureMessage(err)
      })
      open.add(conn)
      ;(conn as unknown as Mysql2ConnectionShim).on('error', () => dead.add(conn))
      return conn
    },

    async release(handle: unknown): Promise<void> {
      const conn = handle as Connection
      open.delete(conn)
      await conn.end()
    },

    validate(handle: unknown): boolean {
      const conn = handle as Connection
      if (dead.has(conn)) return false
      const raw = (conn as unknown as { connection?: RawMysql2Connection }).connection
      if (!raw) return false
      return !raw._fatalError && !raw._protocolError && !raw._closing && !raw.stream.destroyed
    },

    async execute(handle, sql, bindings): Promise<RawResult> {
      const conn = handle as unknown as Mysql2ConnectionShim
      // `query()`, never `execute()`: Hyperdrive does not support MySQL COM_STMT_PREPARE.
      const [rows, fields] = await conn.query(sql, bindings as unknown as QueryValues).catch((err: unknown) => {
        throw ensureMessage(err)
      })
      return toRawResult(rows, fields)
    },

    async *stream(handle, sql, bindings) {
      const raw = (handle as unknown as { connection: RawMysql2Connection }).connection
      const readable = raw.query(sql, bindings).stream()
      for await (const row of readable) yield row
    },

    async destroy(): Promise<void> {
      await Promise.all([...open].map((conn) => conn.end()))
      open.clear()
    },
  }
}

function toRawResult(rows: QueryResult, fields: FieldPacket[]): RawResult {
  if (Array.isArray(rows)) {
    return { rows, fields }
  }
  if (rows && typeof rows === 'object' && ('affectedRows' in rows || 'insertId' in rows)) {
    const meta = rows as { insertId?: number | string; affectedRows?: number }
    return {
      rows: [],
      fields,
      insertId: typeof meta.insertId === 'string' ? BigInt(meta.insertId) : meta.insertId,
      affectedRows: meta.affectedRows,
    }
  }
  throw CfKnexError.malformedResult(
    `mysql2 query returned neither an array of rows nor an object with 'affectedRows'/'insertId' (got ${typeof rows})`,
  )
}
