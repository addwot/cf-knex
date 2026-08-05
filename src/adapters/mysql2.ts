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
    // literal boolean `true` through does not connect first: `createConnection`
    // synchronously builds mysql2's internal `ConnectionConfig` before any
    // socket opens, and that constructor throws `TypeError: SSL profile must
    // be an object, instead it's a boolean` immediately, inside `acquire()`
    // on the very first call. mysql2 only special-cases `typeof ssl ===
    // 'string'` and otherwise requires whatever's left (once truthy) to be
    // an object. `{}` (mysql2's and Node's default TLS settings, i.e.
    // `rejectUnauthorized: true` against Node's default CA store) is the
    // object form of "on".
    ...(ssl ? { ssl: {} } : {}),
  }
}

function resolveConnectionOptions(opts: Mysql2AdapterOptions): ConnectionOptions {
  if (opts.hyperdrive) {
    // Explicit destructure, not `{ ...opts.hyperdrive }`: a real Cloudflare
    // `Hyperdrive` binding carries a sixth own-enumerable property,
    // `connectionString`, alongside the five fields below — spreading it
    // through hands mysql2 a key outside its `validOptions`, which today
    // logs "Ignoring invalid configuration option passed to Connection:
    // connectionString … in future versions of MySQL2, an error will be
    // thrown" on every single connection, and will hard-throw once mysql2
    // makes good on that warning. Reading only the fields this adapter
    // actually declares (`HyperdriveConfig`, five fields) keeps the binding
    // shape honest regardless of what else it carries.
    const { host, port, user, password, database } = opts.hyperdrive
    return { host, port, user, password, database }
  }
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

  // Every connection this adapter has handed out via `acquire()` that
  // hasn't yet been closed via `release()`. `destroy()` is a safety net for
  // whatever's left in here — under normal operation tarn calls `release()`
  // (src/core/client.ts's `destroyRawConnection`) for every handle it holds
  // before `destroy()` ever runs, so this should usually be empty by then.
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
      // `createKnexClient` wires this into knex's `acquireRawConnection()`,
      // which tarn calls only when it needs an additional pooled resource
      // (bounded by pool size, not query count), and `db.transaction()`
      // holds whichever connection it receives for its entire lifetime.
      // Handing the same connection to two callers would let an unrelated
      // query land on the same MySQL session as an open transaction, so it
      // would execute "inside" that transaction instead of against
      // separately-visible state.
      const conn = await mysql.createConnection(config)
      open.add(conn)
      return conn
    },

    // Called when tarn permanently evicts this handle (idle timeout, pool
    // shrink, or the whole pool tearing down) — see the `DriverAdapter` doc
    // comment in src/core/types.ts for why "release" means "close" at this
    // layer, not "return to the pool". Ending an already-open connection a
    // second time here would be a bug on tarn's side, not this adapter's;
    // `open.delete` before `.end()` keeps `destroy()`'s cleanup pass from
    // double-ending it if that ever happens.
    async release(handle: unknown): Promise<void> {
      const conn = handle as Connection
      open.delete(conn)
      await conn.end()
    },

    async execute(handle, sql, bindings): Promise<RawResult> {
      const conn = handle as unknown as QueryableConnection
      const [rows, fields] = await conn.query(sql, bindings as unknown as QueryValues)
      return toRawResult(rows, fields)
    },

    async destroy(): Promise<void> {
      // Ends whatever this adapter created that tarn never released — see
      // the `open` comment above for when that's non-empty — and leaves the
      // adapter itself reusable afterward.
      await Promise.all([...open].map((conn) => conn.end()))
      open.clear()
      // Not a "destroyed" flag: clearing the set (rather than latching a
      // boolean) leaves `acquire()` free to open new connections afterward,
      // exactly as it did before this call.
    },
  }
}

/**
 * mysql2 represents a write result (INSERT/UPDATE/DELETE) as a single
 * `ResultSetHeader`-shaped object, not an array — `rows` above is only ever
 * one of these two shapes, never anything else, for any query this adapter
 * sends. Guard both cases explicitly rather than falling through to `[]` on
 * anything non-array: this file is the template the tidb-http adapter
 * copies, and tidb-http's JSON envelope makes a genuinely malformed shape
 * reachable in a way it never is here. Matches the house pattern already
 * established at src/core/response.ts:51-55 (throw `CfKnexError.malformedResult`
 * at the boundary rather than silently return an empty/wrong result).
 */
function toRawResult(rows: QueryResult, fields: FieldPacket[]): RawResult {
  if (Array.isArray(rows)) {
    return { rows, fields }
  }
  if (rows && typeof rows === 'object' && ('affectedRows' in rows || 'insertId' in rows)) {
    const meta = rows as { insertId?: number | string; affectedRows?: number }
    return {
      rows: [],
      fields,
      // mysql2's `insertId` is typed `number` but its own packet parser
      // (lib/packets/resultset_header.js, via `readLengthCodedNumberSigned`)
      // returns a numeric string instead whenever the value isn't a safe
      // integer — exactly the 64-bit auto-increment / TiDB AUTO_RANDOM case
      // this project's `RawResult.insertId` (number | bigint) exists to
      // carry without precision loss. Normalizing the string case to
      // `bigint` here (rather than widening `RawResult.insertId` to include
      // `string`) keeps that type's contract the same for every adapter and
      // keeps downstream consumers (src/core/response.ts) dealing with one
      // non-number representation of "big integer", not two.
      insertId: typeof meta.insertId === 'string' ? BigInt(meta.insertId) : meta.insertId,
      affectedRows: meta.affectedRows,
    }
  }
  throw CfKnexError.malformedResult(
    `mysql2 query returned neither an array of rows nor an object with 'affectedRows'/'insertId' (got ${typeof rows})`,
  )
}
