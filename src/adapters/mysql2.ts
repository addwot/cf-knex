import { CfKnexError } from '../core/errors'
import type { Credentials, DriverAdapter, RawResult } from '../core/types'
import type { Connection, ConnectionOptions, FieldPacket, QueryResult, QueryValues } from 'mysql2/promise'

/**
 * mysql2/promise's `Connection` composes `.query()`/`.on()` via mixins
 * (`QueryableBase`/`ExecutableBase`, `EventEmitter`) that this project's
 * TypeScript setup doesn't resolve into instance members, even though both
 * exist at runtime (`.end()`, declared directly on the class, checks fine).
 * Declares just the members this adapter calls, typed against mysql2's own
 * result/value types.
 */
type Mysql2ConnectionShim = {
  query(sql: string, values?: QueryValues): Promise<[QueryResult, FieldPacket[]]>
  on(event: 'error', listener: (err: Error) => void): void
}

/**
 * Internal mysql2 connection state, read directly off the raw (non-promise)
 * connection — `mysql2/promise`'s `Connection` wraps it at `.connection`
 * (mysql2/lib/promise/connection.js). Two uses:
 *
 * - `validate()` reads `_fatalError`/`_protocolError`/`_closing`/
 *   `stream.destroyed` — the same four undocumented, underscore-prefixed
 *   fields knex's own mysql2 dialect reads for the same purpose
 *   (knex/lib/dialects/mysql2/index.js's `validateConnection`), verified
 *   against mysql2/lib/base/connection.js. (`stream` here is the raw TCP
 *   socket, unrelated to `query(…).stream()` below.)
 * - `stream()` calls `query()` on this raw connection with no callback,
 *   which mysql2/promise's own `.query()` never does — the raw `query()`
 *   called this way returns the `Query` command object synchronously
 *   (mysql2/lib/base/connection.js), the same object `.stream()`
 *   (mysql2/lib/commands/query.js) hangs off, matching the path knex's own
 *   mysql dialect's `_stream` uses (inherited unchanged by the mysql2
 *   dialect).
 */
type RawMysql2Connection = {
  _fatalError: unknown
  _protocolError: unknown
  _closing: boolean
  stream: { destroyed: boolean }
  query(sql: string, values: unknown[]): { stream(): AsyncIterable<unknown> }
}

/**
 * The five fields this adapter reads off a Hyperdrive-style config (a real
 * Cloudflare `Hyperdrive` binding, or a plain object shaped like one).
 * Declared locally rather than reusing `@cloudflare/workers-types`'
 * `Hyperdrive` interface, which also carries `connect()` and other fields
 * this adapter never touches.
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
    // `Credentials.ssl` is a plain boolean, but mysql2's `ConnectionOptions.ssl`
    // rejects the literal boolean `true` with `TypeError: SSL profile must be
    // an object, instead it's a boolean` (thrown synchronously by
    // `createConnection`, before any socket opens). `{}` is mysql2/Node's
    // default TLS settings (`rejectUnauthorized: true`), the object form of "on".
    ...(ssl ? { ssl: {} } : {}),
  }
}

function resolveConnectionOptions(opts: Mysql2AdapterOptions): ConnectionOptions {
  if (opts.hyperdrive) {
    // Explicit destructure, not `{ ...opts.hyperdrive }`: a real Cloudflare
    // `Hyperdrive` binding also carries `connectionString`, which mysql2
    // would reject as an invalid option (warns today, will hard-throw in a
    // future mysql2 version).
    const { host, port, user, password, database } = opts.hyperdrive
    return { host, port, user, password, database }
  }
  if (opts.connection) return credentialsToConnectionOptions(opts.connection)
  if (opts.url) return { uri: opts.url }
  throw new CfKnexError('NO_CONNECTION', "mysql2 adapter needs one of 'url', 'connection' or 'hyperdrive'")
}

export function createMysql2Adapter(opts: Mysql2AdapterOptions): DriverAdapter {
  // Workers isolates forbid code generation from strings ("Code generation
  // from strings disallowed for this context"). mysql2 compiles its row
  // parsers with `eval` by default, so without `disableEval` every
  // row-returning query fails with that error on Workers (confirmed against
  // a live MySQL under `wrangler dev`). Set once here, after the
  // shape-specific branching above, so all three connection shapes get it.
  const config: ConnectionOptions = { ...resolveConnectionOptions(opts), disableEval: true }

  // Connections handed out via `acquire()` not yet closed via `release()`.
  // `destroy()` is a safety net for whatever's left — tarn normally calls
  // `release()` on every handle before `destroy()` runs, so this is usually
  // empty by then.
  const open = new Set<Connection>()

  // Connections the `error` listener (attached in `acquire()`) has marked
  // dead. `validate()` also checks internal state directly as a belt-and-
  // braces cross-check — the two should always agree.
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
      // A brand-new connection every call, never shared: `db.transaction()`
      // holds whichever connection it receives for its entire lifetime, so
      // handing the same one to two callers would let an unrelated query
      // land inside an open transaction instead of separately-visible state.
      const conn = await mysql.createConnection(config)
      open.add(conn)
      // mysql2/promise's own `createConnectionPromise` already leaves a
      // `once('error', reject)` listener on the raw connection after
      // `createConnection` resolves, so the very first post-connect 'error'
      // event alone wouldn't crash the process even without this listener.
      // But that built-in listener removes itself once it fires, so any
      // *second* 'error' event on an idle pooled connection (a further
      // network blip, another server-side `KILL`) would then be genuinely
      // unhandled — Node's EventEmitter throws on an unhandled 'error' event
      // by default. This persistent `.on()` guards that case for the life of
      // the connection, and marks the handle dead for `validate()` below.
      ;(conn as unknown as Mysql2ConnectionShim).on('error', () => dead.add(conn))
      return conn
    },

    // Called when tarn permanently evicts this handle — see `DriverAdapter`
    // in src/core/types.ts for why "release" means "close" here, not "return
    // to the pool". `open.delete` before `.end()` keeps `destroy()`'s cleanup
    // pass from double-ending this connection if tarn ever calls both.
    async release(handle: unknown): Promise<void> {
      const conn = handle as Connection
      open.delete(conn)
      await conn.end()
    },

    // Tarn calls this before handing a pooled handle back out. Without it, a
    // connection MySQL closed server-side (`KILL`, restart, idle-timeout)
    // stays in rotation forever, failing every later query with "Can't add
    // new command when connection is in closed state". Two checks, either
    // sufficient alone: the `error`-listener flag from `acquire()` (network
    // error while idle), and the same internal-state fields knex's own
    // mysql2 dialect reads (a handshake failure that never emitted 'error').
    // See the `RawMysql2Connection` comment above for `conn.connection`.
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

    // Row-by-row streaming for `db(table).stream()`; src/core/client.ts's
    // `_stream()` drives this generator with its own `for await` and awaits
    // backpressure on its side. The backpressure this method owns — between
    // mysql2's row source and this generator — comes for free below.
    //
    // `disableEval: true` (set once into `config` above) reaches every query
    // this adapter issues, streamed or not: `Query.prototype.start()` builds
    // `this.options` as `Object.assign({}, connection.config, this._queryOptions)`
    // (mysql2/lib/commands/query.js), and `_queryOptions` never overrides
    // `disableEval`. Confirmed against a live connection: streamed rows come
    // back fully parsed, matching the buffered path.
    //
    // `raw.query(sql, values)` with no callback (see the `RawMysql2Connection`
    // comment above for why) returns a real Node `Readable` from `.stream()`
    // that already pauses/resumes the connection based on its own buffer —
    // the same flow control `for await` already uses, so there's nothing
    // extra to add for backpressure here.
    //
    // Early exit: breaking out of `for await` below invokes the async
    // iterator's `return()`, which calls `readable.destroy()` — confirmed
    // empirically that the connection remains usable afterward (a further
    // query on the same handle after an abandoned 50,000-row stream returns
    // correct results, 15/15). This generator has no `finally` and issues no
    // further SQL after the loop, so — unlike src/adapters/pg.ts's `stream()`,
    // which runs `ROLLBACK TO SAVEPOINT`/`CLOSE cursor` after an early exit —
    // there's no async gap for a premature `release()` to land in, and this
    // generator doesn't need pg's `handlesMidTeardown` guard.
    async *stream(handle, sql, bindings) {
      const raw = (handle as unknown as { connection: RawMysql2Connection }).connection
      const readable = raw.query(sql, bindings).stream()
      for await (const row of readable) yield row
    },

    async destroy(): Promise<void> {
      // Ends whatever tarn never released — see the `open` comment above.
      await Promise.all([...open].map((conn) => conn.end()))
      open.clear()
      // Not a "destroyed" flag: clearing (not latching a boolean) leaves
      // `acquire()` free to open new connections afterward.
    },
  }
}

/**
 * mysql2 represents a write result (INSERT/UPDATE/DELETE) as a single
 * `ResultSetHeader`-shaped object, not an array. Guard both cases explicitly
 * rather than falling through to `[]` on anything non-array: this file is
 * the template the tidb-http adapter copies, whose JSON envelope makes a
 * malformed shape reachable in a way it never is here. Matches the house
 * pattern at src/core/response.ts:51-55 (throw at the boundary rather than
 * silently return an empty/wrong result).
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
      // mysql2's `insertId` is typed `number`, but its packet parser
      // (lib/packets/resultset_header.js) returns a numeric string whenever
      // the value isn't a safe integer — the 64-bit auto-increment / TiDB
      // AUTO_RANDOM case `RawResult.insertId` (number | bigint) exists for.
      // Normalizing to `bigint` here (rather than widening the type to
      // include `string`) keeps every adapter's contract the same.
      insertId: typeof meta.insertId === 'string' ? BigInt(meta.insertId) : meta.insertId,
      affectedRows: meta.affectedRows,
    }
  }
  throw CfKnexError.malformedResult(
    `mysql2 query returned neither an array of rows nor an object with 'affectedRows'/'insertId' (got ${typeof rows})`,
  )
}
