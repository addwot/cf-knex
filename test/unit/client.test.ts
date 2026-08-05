import { expect, test } from 'vitest'
import { createKnexClient } from '../../src/core/client'
import { CfKnexError } from '../../src/core/errors'
import { createFakeAdapter } from '../support/fake-adapter'

/**
 * A minimal stand-in for the `StreamSink` type `_stream()` writes into
 * (src/core/client.ts's non-exported `StreamSink`, and the un-exported
 * `waitForDrain`/`StreamSinkClosed` built on top of it) — not a real Node
 * stream, so the tests below can drive 'drain'/'close'/'error' on their own
 * schedule instead of depending on whatever timing a real Transform would
 * produce, and so they run the same way under this project's workerd test
 * project as the node one (this file's `describe`/`test` blocks are not
 * restricted to the `node` vitest project, unlike test/integration/**).
 * `once`/`off` only need to support one outstanding listener per event at a
 * time: `waitForDrain` always calls `off` on the other two events the
 * moment one of the three fires, and none of the tests below issue a second
 * overlapping `_stream()` call against the same sink.
 */
function createFakeSink(opts: { writeReturns?: boolean[] } = {}) {
  const written: unknown[] = []
  let ended = false
  let destroyed = false
  const writeReturns = opts.writeReturns ?? []
  let writeCalls = 0
  const listeners: Record<'drain' | 'close' | 'error', Set<(err?: unknown) => void>> = {
    drain: new Set(),
    close: new Set(),
    error: new Set(),
  }
  // Fires every currently-registered listener for `event` and clears them —
  // modelling `once`'s "fires at most one time" contract without needing a
  // per-listener removal wrapper, since nothing here ever needs more than
  // one outstanding listener per event.
  const fire = (event: 'drain' | 'close' | 'error', err?: unknown) => {
    const toCall = [...listeners[event]]
    listeners[event].clear()
    for (const listener of toCall) listener(err)
  }
  const sink = {
    get destroyed() {
      return destroyed
    },
    write(chunk: unknown): boolean {
      written.push(chunk)
      const result = writeReturns[writeCalls] ?? true
      writeCalls++
      return result
    },
    end() {
      ended = true
    },
    emit(_event: 'error', err: unknown): boolean {
      fire('error', err)
      return true
    },
    once(event: 'drain' | 'close' | 'error', listener: (err?: unknown) => void) {
      listeners[event].add(listener)
    },
    off(event: 'drain' | 'close' | 'error', listener: (err?: unknown) => void) {
      listeners[event].delete(listener)
    },
  }
  return {
    sink,
    written,
    isEnded: () => ended,
    fireDrain: () => fire('drain'),
    // Simulates the consumer walking away mid-stream (e.g. an early `break`
    // out of a `for await` over the real stream `sink` stands in for): the
    // sink is destroyed with no error, which is exactly the case
    // `StreamSinkClosed` (src/core/client.ts) exists to turn into a quiet
    // resolve rather than a hang or a false rejection.
    destroyNow: () => {
      destroyed = true
      fire('close')
    },
  }
}

test('generates dialect-appropriate SQL', async () => {
  const { adapter, calls } = createFakeAdapter({ dialect: 'mysql' })
  const db = createKnexClient(adapter)
  await db('users').where('id', 1).select('name')
  expect(calls[0]?.sql).toBe('select `name` from `users` where `id` = ?')
  expect(calls[0]?.bindings).toEqual([1])
  await db.destroy()
})

test('.first() returns a row, not an array (Defect A regression)', async () => {
  const { adapter } = createFakeAdapter({ dialect: 'mysql', result: { rows: [{ id: 1, tags: 'a,b' }] } })
  const db = createKnexClient(adapter)
  const row = await db('videos').first()
  expect(row).toEqual({ id: 1, tags: 'a,b' })
  expect(Array.isArray(row)).toBe(false)
  await db.destroy()
})

test('.insert() returns the insert id (Defect B regression)', async () => {
  const { adapter } = createFakeAdapter({ dialect: 'mysql', result: { rows: [], insertId: 99 } })
  const db = createKnexClient(adapter)
  expect(await db('users').insert({ name: 'x' })).toEqual([99])
  await db.destroy()
})

test('.update() returns the affected row count', async () => {
  const { adapter } = createFakeAdapter({ dialect: 'mysql', result: { rows: [], affectedRows: 4 } })
  const db = createKnexClient(adapter)
  expect(await db('users').where('id', 1).update({ name: 'y' })).toBe(4)
  await db.destroy()
})

test('postgres selects return rows', async () => {
  const { adapter } = createFakeAdapter({ dialect: 'postgres', result: { rows: [{ id: 1 }], command: 'SELECT' } })
  const db = createKnexClient(adapter)
  expect(await db('users').select('*')).toEqual([{ id: 1 }])
  await db.destroy()
})

test('sqlite inserts return lastID', async () => {
  const { adapter } = createFakeAdapter({ dialect: 'sqlite', result: { rows: [], insertId: 5 } })
  const db = createKnexClient(adapter)
  expect(await db('users').insert({ name: 'x' })).toEqual([5])
  await db.destroy()
})

test('constructing a sqlite client does not throw (colorette/logger regression)', () => {
  // Regression coverage for a real crash: knex's sqlite3 dialect calls
  // `this.logger.warn(...)` at construction time unless `connection.filename`
  // and `useNullAsDefault` are already set, and knex's Logger crashes on any
  // warn/error/deprecate call in this project's test harness (a `colorette`
  // bundling gap — see the long comment above `DIALECT_CLASSES` in
  // src/core/client.ts). createKnexClient defaults both settings away for
  // sqlite specifically so that call is never reached. This test exercises
  // that through the real, unmodified default path — no config overrides —
  // so it fails if that default-avoidance regresses.
  //
  // NOTE: this does *not* prove the underlying colorette/logger crash is
  // fixed — only that this specific call site is avoided. An attempt to
  // write the stronger test the crash's absence would actually require
  // (forcing sqlite3's constructor warn to fire, e.g. via
  // `{ connection: {}, useNullAsDefault: undefined }`, and asserting it
  // doesn't throw) still fails as of this commit; see src/core/client.ts.
  const { adapter } = createFakeAdapter({ dialect: 'sqlite' })
  expect(() => createKnexClient(adapter)).not.toThrow()
})

test('_stream() throws CfKnexError with code UNSUPPORTED_CAPABILITY', () => {
  const { adapter } = createFakeAdapter({ dialect: 'mysql' })
  const db = createKnexClient(adapter)
  const client = db.client as unknown as { _stream: () => unknown }
  expect(() => client._stream()).toThrow(CfKnexError)
  try {
    client._stream()
    throw new Error('expected _stream() to throw')
  } catch (err) {
    expect(err).toBeInstanceOf(CfKnexError)
    expect((err as CfKnexError).code).toBe('UNSUPPORTED_CAPABILITY')
  }
})

test('_stream() throws CfKnexError even when capabilities.streaming is true, if the adapter has no stream() (A9: gate on both)', () => {
  // Regression coverage for A9: `capabilities.streaming` is only a claim;
  // `adapter.stream` existing is the proof. An adapter that sets the flag
  // without implementing the method must still fail with this project's own
  // typed error, not crash on "adapter.stream is not a function" the first
  // time `_stream()` tried to call it.
  const { adapter } = createFakeAdapter({ dialect: 'mysql', capabilities: { streaming: true } })
  const db = createKnexClient(adapter)
  const client = db.client as unknown as { _stream: () => unknown }
  expect(() => client._stream()).toThrow(CfKnexError)
  try {
    client._stream()
    throw new Error('expected _stream() to throw')
  } catch (err) {
    expect(err).toBeInstanceOf(CfKnexError)
    expect((err as CfKnexError).code).toBe('UNSUPPORTED_CAPABILITY')
  }
})

test('_stream() uses the adapter-supplied streaming hint when present, and the generic wording when absent (A6)', () => {
  const { adapter: generic } = createFakeAdapter({ dialect: 'mysql' })
  const dbGeneric = createKnexClient(generic)
  const clientGeneric = dbGeneric.client as unknown as { _stream: () => unknown }
  expect(() => clientGeneric._stream()).toThrowError(/Use \.limit\(\)\/\.offset\(\) to paginate\./)

  const { adapter: custom } = createFakeAdapter({ dialect: 'mysql', hints: { streaming: 'Use batch() instead.' } })
  const dbCustom = createKnexClient(custom)
  const clientCustom = dbCustom.client as unknown as { _stream: () => unknown }
  try {
    clientCustom._stream()
    throw new Error('expected _stream() to throw')
  } catch (err) {
    expect((err as Error).message).toContain('Use batch() instead.')
    expect((err as Error).message).not.toContain('paginate')
  }
})

test("_stream() throws a plain Error (not CfKnexError) for an empty query, matching knex's stock dialects", () => {
  // Both stock dialects this replaces (node_modules/knex/lib/dialects/postgres/
  // index.js and node_modules/knex/lib/dialects/mysql/index.js) guard `!obj.sql`
  // with a synchronous `throw new Error('The query is empty')`, not a
  // rejected promise and not a project-specific error type — knex's own
  // `ensureConnectionStreamCallback` (node_modules/knex/lib/execution/
  // internal/ensure-connection-callback.js) already converts a synchronous
  // throw here into `stream.emit('error', …)` plus a rejection, so this
  // stays inside that already-handled path rather than inventing a new one.
  const { adapter } = createFakeAdapter({
    dialect: 'mysql',
    capabilities: { streaming: true },
    stream: async function* () {},
  })
  const db = createKnexClient(adapter)
  const client = db.client as unknown as {
    _stream: (handle: unknown, obj: Record<string, unknown>, sink: unknown) => unknown
  }
  try {
    client._stream({}, {}, {})
    throw new Error('expected _stream() to throw')
  } catch (err) {
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(CfKnexError)
    expect((err as Error).message).toBe('The query is empty')
  }
})

test('_stream() writes every row from the adapter, in order, and ends the sink (happy path)', async () => {
  const rows = [{ id: 1 }, { id: 2 }, { id: 3 }]
  const { adapter } = createFakeAdapter({
    dialect: 'mysql',
    capabilities: { streaming: true },
    stream: async function* () {
      yield* rows
    },
  })
  const db = createKnexClient(adapter)
  const client = db.client as unknown as {
    _stream: (handle: unknown, obj: Record<string, unknown>, sink: unknown) => Promise<void>
  }
  const { sink, written, isEnded } = createFakeSink()

  await client._stream({}, { sql: 'select * from t', bindings: [] }, sink)

  expect(written).toEqual(rows)
  expect(isEnded()).toBe(true)
})

test('_stream() awaits drain before writing the next row when the sink reports backpressure (A5 regression)', async () => {
  // Regression coverage for a real defect class ("silently-wrong success"):
  // writing every row regardless of the sink's own `write()` return value
  // buffers the *entire* result set in the sink's memory the moment a
  // consumer falls behind by even one row — defeating the only reason to
  // stream in the first place, while still reporting success.
  const rows = [{ id: 1 }, { id: 2 }, { id: 3 }]
  const { adapter } = createFakeAdapter({
    dialect: 'mysql',
    capabilities: { streaming: true },
    stream: async function* () {
      yield* rows
    },
  })
  const db = createKnexClient(adapter)
  const client = db.client as unknown as {
    _stream: (handle: unknown, obj: Record<string, unknown>, sink: unknown) => Promise<void>
  }
  // Only the first write() reports backpressure; every later one succeeds.
  const { sink, written, isEnded, fireDrain } = createFakeSink({ writeReturns: [false] })

  const done = client._stream({}, { sql: 'select * from t', bindings: [] }, sink)

  // Flush a macrotask, not a fixed number of microtask ticks: whatever
  // internal bookkeeping an async generator's first `.next()` needs is
  // guaranteed to have fully drained before a setTimeout callback runs,
  // regardless of exactly how many microtask turns that takes — so this
  // reliably lands after the first `write()` call (which is synchronous,
  // and synchronously followed by suspending on `waitForDrain`'s pending
  // promise) without coupling the test to that internal tick count.
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(written).toEqual([{ id: 1 }])

  fireDrain()
  await done

  expect(written).toEqual(rows)
  expect(isEnded()).toBe(true)
})

test('_stream() rejects and emits on the sink when the adapter stream throws mid-iteration (A4 dual-signal contract)', async () => {
  const boom = new Error('boom')
  const { adapter } = createFakeAdapter({
    dialect: 'mysql',
    capabilities: { streaming: true },
    stream: async function* () {
      yield { id: 1 }
      throw boom
    },
  })
  const db = createKnexClient(adapter)
  const client = db.client as unknown as {
    _stream: (handle: unknown, obj: Record<string, unknown>, sink: unknown) => Promise<void>
  }
  const { sink, written } = createFakeSink()
  // A real consumer of the stream `_stream()` writes into — knex's own
  // Runner.stream() (node_modules/knex/lib/execution/runner.js) or whatever
  // reads/pipes it downstream — always has an 'error' listener attached by
  // the time `_stream()` can reach this path; Node's EventEmitter throws
  // synchronously on `emit('error', …)` with zero listeners, so this
  // mirrors that always-true precondition rather than special-casing it.
  let emitted: unknown
  sink.once('error', (err) => {
    emitted = err
  })

  await expect(client._stream({}, { sql: 'select * from t', bindings: [] }, sink)).rejects.toBe(boom)

  expect(emitted).toBe(boom)
  expect(written).toEqual([{ id: 1 }])
})

test('_stream() resolves quietly (no throw, no emit) when the sink closes while awaiting drain (early-exit teardown, A5)', async () => {
  // Regression coverage for the deadlock/false-rejection this specifically
  // guards against: a consumer stopping early (e.g. `break` inside a
  // `for await` over the real stream) destroys it without an error. A
  // naive drain-wait that only listens for 'drain' would hang forever; one
  // that treats any non-drain settlement as a real failure would reject
  // `_stream()`'s promise (and `emit('error', …)` again) over a consumer
  // simply losing interest, which is not a failure.
  const { adapter } = createFakeAdapter({
    dialect: 'mysql',
    capabilities: { streaming: true },
    stream: async function* () {
      yield { id: 1 }
      yield { id: 2 }
      yield { id: 3 }
    },
  })
  const db = createKnexClient(adapter)
  const client = db.client as unknown as {
    _stream: (handle: unknown, obj: Record<string, unknown>, sink: unknown) => Promise<void>
  }
  const { sink, written, destroyNow } = createFakeSink({ writeReturns: [false] })
  let emitted = false
  sink.once('error', () => {
    emitted = true
  })

  const done = client._stream({}, { sql: 'select * from t', bindings: [] }, sink)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(written).toEqual([{ id: 1 }])

  destroyNow()

  await expect(done).resolves.toBeUndefined()
  expect(emitted).toBe(false)
  expect(written).toEqual([{ id: 1 }])
})

test('db.transaction() rejects with a documented CfKnexError when the adapter declares no transaction support', async () => {
  // Regression coverage for a real gap: knex's own `Client.transaction()`
  // (node_modules/knex/lib/client.js) has no notion of `adapter.capabilities`
  // and will happily hand back a `Transaction` that issues BEGIN/COMMIT/
  // ROLLBACK as ordinary queries through `_query()` -- for an adapter that
  // cannot guarantee those three land on the same underlying session
  // (declared via `capabilities.transactions: false`), that would silently
  // no-op every rollback instead of failing loudly. `CfKnexClient.transaction`
  // in src/core/client.ts must gate on the flag before ever reaching knex's
  // `Transaction`, mirroring the existing `_stream()` throw just above.
  const { adapter } = createFakeAdapter({ dialect: 'mysql', capabilities: { transactions: false } })
  const db = createKnexClient(adapter)

  await expect(db.transaction(async () => {})).rejects.toThrow(/not supported/i)
  try {
    await db.transaction(async () => {})
    throw new Error('expected db.transaction() to throw')
  } catch (err) {
    expect(err).toBeInstanceOf(CfKnexError)
    expect((err as CfKnexError).code).toBe('UNSUPPORTED_CAPABILITY')
  }

  await db.destroy()
})

test('db.transaction() uses the adapter-supplied transactions hint when present, and the generic wording when absent (A6)', async () => {
  const { adapter: generic } = createFakeAdapter({ dialect: 'mysql', capabilities: { transactions: false } })
  const dbGeneric = createKnexClient(generic)
  await expect(dbGeneric.transaction(async () => {})).rejects.toThrow(/BEGIN\/COMMIT\/ROLLBACK/)
  await dbGeneric.destroy()

  const { adapter: custom } = createFakeAdapter({
    dialect: 'mysql',
    capabilities: { transactions: false },
    hints: { transactions: 'Use runBatch() instead.' },
  })
  const dbCustom = createKnexClient(custom)
  try {
    await dbCustom.transaction(async () => {})
    throw new Error('expected db.transaction() to reject')
  } catch (err) {
    expect((err as Error).message).toContain('Use runBatch() instead.')
    expect((err as Error).message).not.toContain('BEGIN/COMMIT/ROLLBACK')
  }
  await dbCustom.destroy()
})

test('sequential queries reuse a pooled connection instead of acquiring one per query (regression)', async () => {
  // Regression coverage for the original bug: `createKnexClient` used to
  // override knex's higher-level `acquireConnection`/`releaseConnection`
  // directly, calling into `adapter.acquire()` on every single query and
  // never returning anything to knex's own pool (tarn). Overriding the
  // lower-level `acquireRawConnection`/`destroyRawConnection`/
  // `validateConnection` hooks instead (src/core/client.ts) lets tarn
  // genuinely pool the handle `adapter.acquire()` hands out — five
  // sequential, fully-awaited queries against one idle-then-reused
  // connection should call `adapter.acquire()` once, not five times.
  const { adapter, acquireCount } = createFakeAdapter({ dialect: 'mysql' })
  const db = createKnexClient(adapter)
  for (let i = 0; i < 5; i++) {
    await db('users').where('id', i).select('name')
  }
  expect(acquireCount()).toBe(1)
  await db.destroy()
})

test('knex.destroy() releases every pooled connection and reaches adapter.destroy() (regression)', async () => {
  // Regression coverage for the second half of the same bug: `adapter.destroy()`
  // used to be unreachable from the public API (`CfKnexClient` never
  // overrode `destroy()`, and knex's own `Client.destroy()` only tears down
  // the pool, which it never actually held anything in). This asserts both
  // halves of the fix: every handle the pool acquired gets released (closed)
  // during pool teardown, and the adapter's own `destroy()` still runs
  // afterward for state that outlives any single handle.
  const { adapter, handles, wasReleased, destroyCount } = createFakeAdapter({ dialect: 'mysql' })
  const db = createKnexClient(adapter)
  await db('users').select('name')
  expect(handles.length).toBeGreaterThan(0)

  await db.destroy()

  for (const handle of handles) {
    expect(wasReleased(handle)).toBe(true)
  }
  expect(destroyCount()).toBe(1)
})

test('caller-supplied knexOptions cannot break the client or the sqlite defaults (precedence regression)', async () => {
  // `connection` must merge with, not replace, the sqlite defaults --
  // omitting `filename` here would otherwise reintroduce the
  // colorette/logger crash documented in src/core/client.ts.
  const { adapter: sqliteAdapter } = createFakeAdapter({ dialect: 'sqlite' })
  let sqliteDb: ReturnType<typeof createKnexClient> | undefined
  expect(() => {
    sqliteDb = createKnexClient(sqliteAdapter, { connection: {} })
  }).not.toThrow()
  await sqliteDb?.destroy()

  // `client` must always be `CfKnexClient` -- a caller-supplied `client`
  // must not replace it, or every adapter call stops working.
  const { adapter, calls } = createFakeAdapter({ dialect: 'mysql' })
  class NotOurClient {}
  const db = createKnexClient(adapter, { client: NotOurClient })
  await db('users').where('id', 1).select('name')
  expect(calls[0]?.sql).toBe('select `name` from `users` where `id` = ?')
  await db.destroy()
})

test('a handle validate() marks stale is evicted and a fresh one acquired on the next query (Finding A regression)', async () => {
  // Regression coverage for a real bug: `validateConnection` used to return
  // `true` unconditionally, so a connection that died while sitting idle in
  // the pool (server-side `KILL`, network drop) stayed in rotation forever
  // and poisoned every later query. `DriverAdapter.validate` (src/core/
  // types.ts) exists so the adapter can tell tarn a handle has gone stale;
  // `CfKnexClient.validateConnection` (src/core/client.ts) must actually
  // delegate to it. The fake adapter's `invalidateAfterFirstUse` flips
  // `validate()` to `false` for any handle already used once, standing in
  // for "this connection died between queries" without needing a real
  // database.
  const { adapter, acquireCount, handles, wasReleased } = createFakeAdapter({
    dialect: 'mysql',
    invalidateAfterFirstUse: true,
  })
  const db = createKnexClient(adapter)

  await db('users').select('name')
  expect(acquireCount()).toBe(1)

  // The handle from the first query is now "used", so validate() will
  // report it stale the moment tarn tries to hand it back out -- this
  // second query must therefore evict it (release) and acquire a new one,
  // not reuse it the way the sequential-reuse regression test above
  // requires when nothing has gone stale.
  await db('users').select('name')
  expect(acquireCount()).toBe(2)
  expect(handles.length).toBe(2)
  expect(wasReleased(handles[0])).toBe(true)

  await db.destroy()
})

test('trx.destroy() inside an open transaction does not tear down the adapter or break the parent db (Finding C regression)', async () => {
  // Regression coverage for a real bug: `destroy()` used to call
  // `adapter.destroy()` unconditionally, but knex's transactor client
  // shares the real client's prototype (execution/transaction.js's
  // `makeTxClient`), so `trx.destroy()` inside a transaction resolved to
  // this same method and tore down every connection the adapter held --
  // including the one the transaction itself still needed to commit,
  // breaking the parent `db` permanently. The `this.transacting` guard in
  // src/core/client.ts's `destroy()` exists to stop that.
  const { adapter, destroyCount } = createFakeAdapter({ dialect: 'mysql' })
  const db = createKnexClient(adapter)

  await db.transaction(async (trx) => {
    await trx('users').insert({ name: 'x' })
    await trx.destroy()
  })
  expect(destroyCount()).toBe(0)

  // The parent client must still be usable after the transactor was
  // destroyed -- this is what "did not break the parent db" means in
  // practice, not just that adapter.destroy() was skipped.
  await db('users').select('name')

  await db.destroy()
  expect(destroyCount()).toBe(1)
})

test("an explicit caller pool option overrides the Workers-appropriate default (min: 0, max: 5)", async () => {
  // createKnexClient defaults to `pool: { min: 0, max: 5 }` (see the
  // `poolDefault` comment in src/core/client.ts) specifically because this
  // library's usage pattern is a fresh client per request -- but knex/tarn
  // read whatever `pool` config actually reaches `Knex()`, so a caller who
  // knows their own workload (e.g. a long-lived Node process, not a Worker
  // isolate) must still be able to opt back into a warmer pool. Asserting
  // this from the outside, black-box, via tarn's own reported pool state
  // (`db.client.pool`) rather than by reaching into createKnexClient's
  // internals -- this is what a caller actually observes.
  const { adapter } = createFakeAdapter({ dialect: 'mysql' })
  const db = createKnexClient(adapter, { pool: { min: 1, max: 3 } })
  const pool = (db.client as unknown as { pool: { min: number; max: number } }).pool
  expect(pool.min).toBe(1)
  expect(pool.max).toBe(3)
  await db.destroy()
})
