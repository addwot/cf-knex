import { CfKnexError } from '../core/errors'
import type { Credentials, DriverAdapter, RawResult } from '../core/types'
import type { Connection, ConnectionOptions, FieldPacket, QueryResult, QueryValues } from 'mysql2/promise'

/**
 * mysql2/promise's own `Connection` class composes `.query()` through mixin
 * helpers (`QueryableBase`/`ExecutableBase` in its `.d.ts`) that this
 * project's TypeScript setup does not resolve into an instance member —
 * `.end()`, declared directly on the class body, checks fine; `.query()`,
 * contributed only through that mixin chain, does not, even though both
 * exist at runtime. Declare just the one overload this adapter calls,
 * typed against mysql2's own exported result/value types, rather than
 * casting the call away untyped.
 */
type QueryableConnection = {
  query(sql: string, values?: QueryValues): Promise<[QueryResult, FieldPacket[]]>
}

/**
 * The five fields this adapter reads off a Hyperdrive-style config, whether
 * that's a real Cloudflare `Hyperdrive` binding or a plain object shaped
 * like one. Declared locally rather than reusing `@cloudflare/workers-types`'
 * ambient `Hyperdrive` interface — that type also carries a `connect()`
 * method and other fields this adapter never touches, and pinning to the
 * subset it actually reads is what keeps that contract honest.
 */
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
    // `Credentials.ssl` is a plain boolean; mysql2's `ConnectionOptions.ssl`
    // wants either a named profile string or an options object — passing the
    // literal boolean `true` through connects, then throws at query time
    // ("SSL profile must be an object, instead it's a boolean"), since
    // mysql2 only special-cases `typeof ssl === 'string'` and otherwise
    // requires whatever's left (once truthy) to be an object. `{}` (mysql2's
    // and Node's default TLS settings) is the object form of "on".
    ...(ssl ? { ssl: {} } : {}),
  }
}

function resolveConnectionOptions(opts: Mysql2AdapterOptions): ConnectionOptions {
  if (opts.hyperdrive) return { ...opts.hyperdrive }
  if (opts.connection) return credentialsToConnectionOptions(opts.connection)
  if (opts.url) return { uri: opts.url }
  throw new CfKnexError('NO_CONNECTION', "mysql2 adapter needs one of 'url', 'connection' or 'hyperdrive'")
}

export function createMysql2Adapter(opts: Mysql2AdapterOptions): DriverAdapter {
  // Workers isolates forbid code generation from strings — any attempt trips
  // "Code generation from strings disallowed for this context". mysql2
  // compiles its row parsers with `eval` by default, and without this flag
  // every row-returning query fails with exactly that error the first time
  // it runs on Workers. Established empirically against a live MySQL under
  // `wrangler dev`. Applies to all three connection shapes resolved above —
  // `disableEval` is added once here, after the shape-specific branching,
  // so none of them can end up without it.
  const config: ConnectionOptions = { ...resolveConnectionOptions(opts), disableEval: true }

  // Every connection this adapter has handed out via `acquire()` and not
  // yet closed. `destroy()` is the only place connections actually get
  // closed — see `release()` below for why.
  const open = new Set<Connection>()

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
      // A brand-new connection on every call — never one cached and shared.
      // `createKnexClient` wires this into knex's `acquireConnection()`,
      // which knex's pool (tarn) calls once per pooled resource (up to 10 by
      // default), and `db.transaction()` holds whichever connection it
      // receives for its entire lifetime. Handing the same connection to two
      // callers would let an unrelated query land on the same MySQL session
      // as an open transaction, so it would execute "inside" that
      // transaction instead of against separately-visible state.
      const conn = await mysql.createConnection(config)
      open.add(conn)
      return conn
    },

    // In knex, `releaseConnection` returns a connection to knex's own pool —
    // it does not close it. The pool still considers the connection live and
    // will hand it to a later `acquireConnection()` call. Closing the socket
    // here would destroy a connection knex still believes it owns.
    async release(): Promise<void> {},

    async execute(handle, sql, bindings): Promise<RawResult> {
      const conn = handle as unknown as QueryableConnection
      const [rows, fields] = await conn.query(sql, bindings as unknown as QueryValues)
      const meta = rows as { insertId?: number; affectedRows?: number }
      return {
        rows: Array.isArray(rows) ? rows : [],
        fields,
        insertId: meta.insertId,
        affectedRows: meta.affectedRows,
      }
    },

    async destroy(): Promise<void> {
      // Ends every connection this adapter created that is still open. This
      // is the only teardown path — knex's stock mysql2 dialect would
      // normally do this via `destroyRawConnection` during pool eviction,
      // but `CfKnexClient` (src/core/client.ts) overrides `acquireConnection`
      // / `releaseConnection` to call straight into this adapter, bypassing
      // knex's tarn pool entirely, so tarn never tracks these connections and
      // never reaps them.
      await Promise.all([...open].map((conn) => conn.end()))
      open.clear()
      // Not a "destroyed" flag: clearing the set (rather than latching a
      // boolean) leaves `acquire()` free to open new connections afterward,
      // exactly as it did before this call.
    },
  }
}
