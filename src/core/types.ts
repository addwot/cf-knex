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

export type CapabilityHints = Partial<Record<keyof AdapterCapabilities, string>>

/**
 * The connection-lifecycle contract every adapter implements. These methods
 * are wired into knex's tarn-backed pool at the raw-connection layer
 * (`acquireRawConnection` / `destroyRawConnection` / `validateConnection` /
 * `Client.destroy`), not the higher-level `acquireConnection` /
 * `releaseConnection`, so the pool genuinely pools adapter handles.
 *
 * - `acquire()` creates one new handle; call volume is bounded by pool max.
 * - `release(handle)` permanently CLOSES that handle — unlike knex's
 *   higher-level API, where the same name means "return to the pool for
 *   reuse". Treating it as a no-op leaks one connection per acquire.
 * - `destroy()` tears down adapter-level state outliving any single handle,
 *   and is the adapter's backstop for handles the pool never released:
 *   `Client.destroy()` (./client.ts) bounds how long it waits for the pool's
 *   release pass, so a slow pass can still be draining when `destroy()`
 *   starts. It must tolerate a later `release()` for an already-closed
 *   handle, and repeat calls.
 *
 * `validate(handle)` is optional: return `false` only when a pooled handle
 * is known dead — one left in rotation poisons every later query that draws
 * it. HTTP-backed (tidb-http) and binding-backed (D1) adapters can't go
 * stale this way, so omitting it there means "always valid".
 *
 * `hints` is optional too: omitting it, rather than setting keys to
 * `undefined`, keeps an adapter on the generic wording.
 */
export type DriverAdapter = {
  readonly dialect: Dialect
  readonly driver: DriverName
  readonly capabilities: AdapterCapabilities
  readonly hints?: CapabilityHints
  acquire(): Promise<unknown>
  release(handle: unknown): Promise<void>
  validate?(handle: unknown): boolean
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
  timeoutMs?: number
  fetch?: typeof fetch
  connection?: Credentials
  hyperdrive?: { host: string; port: number; user: string; password: string; database: string; connectionString: string }
  binding?: unknown
  knex?: Record<string, unknown>
}
