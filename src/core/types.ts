export type Dialect = 'mysql' | 'postgres' | 'sqlite'
export type Engine = 'mysql' | 'postgres' | 'sqlite'
export type DriverName = 'mysql2' | 'tidb-http' | 'pg' | 'd1' | 'libsql'

export type RawResult = {
  rows: unknown[]
  fields?: unknown[]
  insertId?: number | bigint
  affectedRows?: number
  command?: string
}

export type AdapterCapabilities = {
  streaming: boolean
  transactions: boolean
}

/**
 * The connection-lifecycle contract every adapter implements. `createKnexClient`
 * (src/core/client.ts) wires these four methods directly into knex's own
 * tarn-backed pool, at the raw-connection layer (`acquireRawConnection` /
 * `destroyRawConnection` / `validateConnection` / `Client.destroy`) rather
 * than the higher-level `acquireConnection` / `releaseConnection` — so the
 * pool genuinely pools adapter handles instead of being bypassed. That
 * placement fixes each method's meaning:
 *
 * - `acquire()` creates and returns one new connection/handle. tarn calls
 *   this only when it needs an additional pooled resource, not once per
 *   query — call volume is bounded by the pool's max size, never by query
 *   count.
 * - `release(handle)` permanently CLOSES that handle. Despite the name
 *   (borrowed from knex's higher-level API, where "release" means "return
 *   to the pool for reuse"), at this layer tarn calls it only when evicting
 *   a resource for good — idle timeout, pool shrink, or the pool tearing
 *   down entirely — never to hand the same handle to another caller. An
 *   adapter that treats this as a no-op leaks one connection per acquire.
 * - `destroy()` tears down adapter-level state that outlives any single
 *   handle (e.g. connections the adapter opened that never made it back
 *   through `release`, cached clients, etc). Called once, after the pool
 *   has already released everything it currently holds.
 */
export type DriverAdapter = {
  readonly dialect: Dialect
  readonly driver: DriverName
  readonly capabilities: AdapterCapabilities
  acquire(): Promise<unknown>
  release(handle: unknown): Promise<void>
  execute(handle: unknown, sql: string, bindings: unknown[]): Promise<RawResult>
  stream?(handle: unknown, sql: string, bindings: unknown[]): AsyncIterable<unknown>
  destroy(): Promise<void>
}

export type Credentials = {
  host: string
  port?: number
  user: string
  password: string
  database: string
  ssl?: boolean
}

export type ClientConfig = {
  engine: Engine
  driver?: DriverName
  url?: string
  authToken?: string
  connection?: Credentials
  hyperdrive?: { host: string; port: number; user: string; password: string; database: string; connectionString: string }
  binding?: unknown
  knex?: Record<string, unknown>
}
