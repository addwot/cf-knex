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
 * Adapter-supplied replacement text for `CfKnexError.unsupported`'s hint,
 * keyed by capability. Lets an adapter name its real alternative instead of
 * the generic wording `_stream()`/`transaction()` fall back to. A key absent
 * here (or the whole object absent) keeps that generic wording unchanged.
 */
export type CapabilityHints = Partial<Record<keyof AdapterCapabilities, string>>

/**
 * The connection-lifecycle contract every adapter implements. These methods
 * are wired into knex's tarn-backed pool at the raw-connection layer
 * (`acquireRawConnection` / `destroyRawConnection` / `validateConnection` /
 * `Client.destroy`), not the higher-level `acquireConnection` /
 * `releaseConnection`, so the pool genuinely pools adapter handles. That
 * placement fixes each method's meaning:
 *
 * - `acquire()` creates one new handle. tarn calls it only when it needs an
 *   additional pooled resource, so call volume is bounded by pool max, not
 *   by query count.
 * - `release(handle)` permanently CLOSES that handle. The name is borrowed
 *   from knex's higher-level API, where it means "return to the pool for
 *   reuse"; at this layer tarn calls it only when evicting a resource for
 *   good. An adapter that treats it as a no-op leaks one connection per
 *   acquire.
 * - `destroy()` tears down adapter-level state outliving any single handle,
 *   **and is the adapter's own backstop for handles the pool never released.**
 *   Normally it runs after the pool's release pass has finished. It is not
 *   guaranteed to: `Client.destroy()` (./client.ts) bounds how long it waits
 *   for that pass, and on a pool that overruns its budget — a connection still
 *   checked out by an abandoned transaction — `destroy()` starts while the pass
 *   is still draining. So an implementation must tolerate a later `release()`
 *   for a handle it already closed, must not assume its own bookkeeping is
 *   empty, and must tolerate repeat calls.
 *
 * `validate(handle)` is optional: it tells a live pooled handle from one that
 * died while idle (killed server-side, network drop), which would otherwise
 * stay in rotation and poison every later query. Return `false` only when the
 * handle is known dead. Omit it for handles that cannot go stale this way —
 * HTTP-backed (tidb-http) and binding-backed (D1) adapters — where a missing
 * `validate` correctly means "always valid".
 *
 * `hints` is optional for the same reason: omitting it entirely, rather than
 * setting keys to `undefined`, is what keeps an adapter on the generic
 * wording.
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
  /**
   * Per-request timeout, in milliseconds. `tidb-http` only, the same way
   * `authToken` above is `libsql` only — carried here so the root entry can
   * configure everything `cf-knex/tidb` can, rather than the subpath quietly
   * being the more capable of the two. Ignored by every other driver, whose
   * transports bound themselves. See `TidbHttpAdapterOptions` in
   * ../adapters/tidb-http.ts for what it does and why there is no default.
   */
  timeoutMs?: number
  /** Replaces the `fetch` handed to the driver. `tidb-http` only, as above. */
  fetch?: typeof fetch
  connection?: Credentials
  hyperdrive?: { host: string; port: number; user: string; password: string; database: string; connectionString: string }
  binding?: unknown
  knex?: Record<string, unknown>
}
