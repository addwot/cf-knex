import { CfKnexError } from '../core/errors'
import type { Credentials, DriverAdapter, RawResult } from '../core/types'
import type { Connection, ConnectionOptions, FieldPacket, QueryResult, QueryValues } from 'mysql2/promise'

/**
 * mysql2/promise's own `Connection` class composes both `.query()` and
 * `.on()` through mixin helpers (`QueryableBase`/`ExecutableBase`, plus
 * extending `EventEmitter`, per its `.d.ts` and
 * mysql2/lib/promise/connection.js) that this project's TypeScript setup
 * does not resolve into instance members — `.end()`, declared directly on
 * the class body, checks fine; these two, contributed only through that
 * mixin/inheritance chain, do not, even though all three exist at runtime.
 * Declare just the members this adapter actually calls, typed against
 * mysql2's own exported result/value types where relevant, rather than
 * casting every call away untyped.
 */
type Mysql2ConnectionShim = {
  query(sql: string, values?: QueryValues): Promise<[QueryResult, FieldPacket[]]>
  on(event: 'error', listener: (err: Error) => void): void
}

/**
 * The subset of mysql2's *internal* connection state this adapter reads to
 * decide whether a pooled handle is still usable — the same four fields
 * knex's own stock mysql2 dialect reads for the same purpose
 * (node_modules/knex/lib/dialects/mysql2/index.js's `validateConnection`).
 * None of these are part of mysql2's public `.d.ts` (they're underscore-
 * prefixed / undocumented); verified directly against
 * node_modules/mysql2/lib/base/connection.js, which sets `_fatalError`/
 * `_protocolError`/`_closing` on protocol errors and dropped sockets, and
 * `stream.destroyed` once the underlying TCP socket is gone. `mysql2/promise`'s
 * `Connection` wraps this raw connection at `.connection` — one layer deeper
 * than knex's own dialect reads, since knex talks to the raw connection
 * directly and this adapter hands out the promise wrapper instead.
 */
type RawMysql2Connection = {
  _fatalError: unknown
  _protocolError: unknown
  _closing: boolean
  stream: { destroyed: boolean }
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

  // Handles a network error or a server-side `KILL` marked dead by the
  // `error` listener attached in `acquire()` below. `validate()` also
  // inspects the connection's own internal state directly (belt-and-
  // braces: the two should always agree, since that internal state is what
  // *causes* the 'error' event in the first place), so this set mostly
  // exists to make the "why is this dead" question answerable from one
  // place rather than re-deriving it from private mysql2 fields every time.
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
      // `PromiseConnection` (this adapter's handle type) re-emits the raw
      // connection's 'error' event, and Node's EventEmitter throws on an
      // unhandled 'error' event by default — but mysql2/promise's own
      // `createConnectionPromise` (mysql2/promise.js) already leaves a
      // `once('error', reject)` listener on the *raw* connection after
      // `createConnection` resolves (it's only removed once it actually
      // fires, not once the connection succeeds), so the very first
      // post-connect 'error' event alone would not crash the process even
      // without this listener — verified: `rawConnection.listenerCount
      // ('error') === 1` immediately after `createConnection`, with no
      // adapter listener attached yet. What that leftover listener doesn't
      // cover is the *second* 'error' event on the same connection: once
      // the built-in `once` fires, it removes itself, and any further
      // 'error' event on an idle pooled connection (network blip after a
      // first blip, a second server-side `KILL` attempt, etc) would then be
      // genuinely unhandled. This listener — a persistent `.on()`, not a
      // one-shot `.once()` — is what actually guards that case, for as long
      // as the connection lives. It also marks the handle dead for
      // `validate()` below, so the pool discards it instead of handing it
      // back out.
      ;(conn as unknown as Mysql2ConnectionShim).on('error', () => dead.add(conn))
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

    // Tarn calls this before handing a pooled handle back out for a query —
    // without it, a connection MySQL closed server-side (`KILL`, a restart,
    // an idle-timeout on the server's side) while sitting idle in the pool
    // stays in rotation forever: every later query on it fails with mysql2's
    // "Can't add new command when connection is in closed state", and unlike
    // the stock knex mysql2 dialect (which discards a dead connection and
    // creates a fresh one on the very next acquire), nothing here would ever
    // self-heal. Two checks, either sufficient on its own: the `error`-
    // listener flag set in `acquire()` (catches the common case, a network
    // error firing while nothing is querying the connection), and the same
    // four internal-state fields knex's own mysql2 dialect reads (catches
    // the handshake having already failed a way that never emitted 'error'
    // on this specific handle). `conn.connection` is the raw connection
    // `PromiseConnection` wraps — see the `RawMysql2Connection` comment
    // above for why this reads one layer deeper than knex's own dialect.
    validate(handle: unknown): boolean {
      const conn = handle as Connection
      if (dead.has(conn)) return false
      const raw = (conn as unknown as { connection?: RawMysql2Connection }).connection
      if (!raw) return false
      return !raw._fatalError && !raw._protocolError && !raw._closing && !raw.stream.destroyed
    },

    async execute(handle, sql, bindings): Promise<RawResult> {
      const conn = handle as unknown as Mysql2ConnectionShim
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
