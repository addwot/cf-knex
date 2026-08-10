import { expect, test } from 'vitest'
import { createKnexClient, hardenMigrationAccessors } from '../../src/core/client'
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
  // Calls to the sink's own `emit()` method specifically — the one
  // `_stream()`'s catch block calls (`stream.emit('error', err)`), as
  // opposed to `fire()` below, which is how this fake's own internal
  // helpers (`destroyNow()`) simulate a *real* Transform's independent,
  // Node-generated 'error'/'close' events. Keeping these two paths
  // distinguishable is what lets a test tell "the sink itself naturally
  // emitted an abort on destroy" (expected, not a bug) apart from "`_stream()`'s
  // own code additionally, redundantly re-emitted on top of it" (the actual
  // regression the test below covers — see its own comment).
  let emitCalls = 0
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
      emitCalls++
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
    emitCallCount: () => emitCalls,
    fireDrain: () => fire('drain'),
    // Simulates the consumer walking away mid-stream (e.g. an early `break`
    // out of a `for await` over the real stream `sink` stands in for) —
    // matching real `Transform` behavior, confirmed empirically and
    // consistently against Node's actual `Readable` async-iterator
    // machinery, not just the easy no-error case: destroying it this way
    // fires 'error' (an `AbortError`, `code: 'ABORT_ERR'`) *before* 'close',
    // not close alone. Both are exactly the case `StreamSinkClosed`
    // (src/core/client.ts) exists to turn into a quiet resolve rather than a
    // hang or a false rejection — see that file's `isSinkAbortedByReader`.
    destroyNow: () => {
      destroyed = true
      const abortErr = new Error('The operation was aborted')
      abortErr.name = 'AbortError'
      ;(abortErr as unknown as { code: string }).code = 'ABORT_ERR'
      fire('error', abortErr)
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

test('.first() returns a row, not an array', async () => {
  const { adapter } = createFakeAdapter({ dialect: 'mysql', result: { rows: [{ id: 1, tags: 'a,b' }] } })
  const db = createKnexClient(adapter)
  const row = await db('videos').first()
  expect(row).toEqual({ id: 1, tags: 'a,b' })
  expect(Array.isArray(row)).toBe(false)
  await db.destroy()
})

test('.insert() returns the insert id', async () => {
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

test('_stream() throws CfKnexError even when capabilities.streaming is true, if the adapter has no stream() (gates on both the capability and a real stream())', () => {
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

test('_stream() uses the adapter-supplied streaming hint when present, and the generic wording when absent', () => {
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

test('_stream() awaits drain before writing the next row when the sink reports backpressure', async () => {
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

test('_stream() rejects and emits on the sink when the adapter stream throws mid-iteration (both signals, not just one)', async () => {
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

test('_stream() resolves quietly (no throw, no re-emit) when the sink closes while awaiting drain (early-exit teardown)', async () => {
  // Regression coverage for the deadlock/false-rejection this specifically
  // guards against: a consumer stopping early (e.g. `break` inside a
  // `for await` over the real stream) destroys it — and, confirmed live
  // against a real `Transform`, does so by emitting 'error' (an
  // `AbortError`, `code: 'ABORT_ERR'`) *before* 'close', not close alone
  // (`createFakeSink`'s `destroyNow()` reproduces that exact sequence, not
  // a simplified close-only one — see its comment). A naive drain-wait that
  // only listens for 'drain' would hang forever; one that treats *every*
  // 'error' as a real failure (this test's whole reason to exist: an earlier
  // fake sink here never fired 'error' on destroy at all, so nothing ever
  // exercised this) would reject `_stream()`'s promise and `emit('error', …)`
  // a *second* time over a consumer simply losing interest, which is not a
  // failure — `emitCallCount()` below checks for exactly that second,
  // redundant emission from `_stream()`'s own code, separately from the
  // sink's own natural one `destroyNow()` fires.
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
  const { sink, written, destroyNow, emitCallCount } = createFakeSink({ writeReturns: [false] })

  const done = client._stream({}, { sql: 'select * from t', bindings: [] }, sink)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(written).toEqual([{ id: 1 }])

  destroyNow()

  await expect(done).resolves.toBeUndefined()
  expect(emitCallCount()).toBe(0)
  expect(written).toEqual([{ id: 1 }])
})

test('_stream() also resolves quietly when a natural drain and the sink closing race each other', async () => {
  // The test above covers 'error' arriving while `waitForDrain` is still
  // waiting for the *first* 'drain'. There is a second, untested half of the
  // same window: confirmed live against a real backpressured `Transform`
  // being consumed via `for await`, a natural 'drain' (the sink's buffer
  // genuinely catching up) can fire *before* an early exit's 'error'/'close'
  // rather than instead of it — the full observed order is 'drain', then
  // 'error' (AbortError), then 'close'. When that happens, `waitForDrain`'s
  // first call resolves via that genuine 'drain', and `_stream()`'s loop
  // goes straight back to `stream.write()` for the next row while the sink
  // is not yet destroyed. If that next write is itself still backpressured,
  // `waitForDrain` is called a *second* time — and it must still resolve
  // this quietly rather than hang or throw once the sink closes moments
  // later, exactly like the first call does. `fireDrain()` (unlike
  // `destroyNow()`) does not touch `destroyed`, so calling it before
  // `destroyNow()` reproduces this exact ordering rather than the
  // close-only or single-drain shapes the other tests above already cover.
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
  // Both writes report backpressure, so the loop calls `waitForDrain` twice:
  // once for row 1 (resolved below by the natural `fireDrain()`), once for
  // row 2 (resolved by `destroyNow()`'s 'error' arriving while still armed).
  const { sink, written, destroyNow, fireDrain, emitCallCount } = createFakeSink({ writeReturns: [false, false] })

  const done = client._stream({}, { sql: 'select * from t', bindings: [] }, sink)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(written).toEqual([{ id: 1 }])

  fireDrain()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(written).toEqual([{ id: 1 }, { id: 2 }])

  destroyNow()

  await expect(done).resolves.toBeUndefined()
  expect(emitCallCount()).toBe(0)
  expect(written).toEqual([{ id: 1 }, { id: 2 }])
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

test('db.transaction() uses the adapter-supplied transactions hint when present, and the generic wording when absent', async () => {
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

// The bug these three cover: knex's execution/transaction.js `query()` catches
// whatever the COMMIT statement threw, assigns it to the transaction's *own*
// promise via `_rejecter`, and then resolves the promise `commit()` returned
// anyway. In the callback form that is harmless — `db.transaction(cb)` returns
// the transaction's promise, so the caller still sees the error. On the bare
// transactor form it loses the error outright: make-knex.js's `_transaction()`
// wires that promise to a `reject` it has already resolved, so nothing is
// listening, and `await trx.commit()` resolves as if the commit had succeeded.
// The write is gone and the caller is told it worked.
//
// Driven through the fake adapter rather than a real database because the
// mechanism is knex's, not any backend's: any adapter error on COMMIT — a
// dropped connection mid-commit, postgres turning it into a ROLLBACK — is
// swallowed the same way. test/integration/pg.test.ts covers the real
// COMMIT_SILENTLY_ROLLED_BACK case this was found through.
test('await trx.commit() rejects when the COMMIT fails, instead of resolving as though it succeeded', async () => {
  const { adapter } = createFakeAdapter({
    dialect: 'mysql',
    failExecute: (sql) => (/^COMMIT/i.test(sql) ? new Error('commit refused by server') : undefined),
  })
  const db = createKnexClient(adapter)
  const trx = await db.transaction()
  await trx.raw('select 1')
  await expect(trx.commit()).rejects.toThrow('commit refused by server')
  await db.destroy()
})

test('await using trx + commit() surfaces a failed COMMIT (the pattern the guide recommends)', async () => {
  // Asserts on object identity rather than the message, and not to dodge
  // knex's `${sql} - ${message}` prefix: identity is the property the pg
  // integration test depends on. Surfacing a *copy* would satisfy any message
  // assertion while stripping the class and `code` off a `CfKnexError`,
  // leaving `err.code === 'COMMIT_SILENTLY_ROLLED_BACK'` — the whole point of
  // routing the error out — unreachable. knex mutates `message` on the
  // adapter's own error and rethrows it, so the caller must get that instance.
  const failure = new Error('commit refused by server')
  const { adapter } = createFakeAdapter({
    dialect: 'mysql',
    failExecute: (sql) => (/^COMMIT/i.test(sql) ? failure : undefined),
  })
  const db = createKnexClient(adapter)
  let seen: unknown
  {
    await using trx = await db.transaction()
    await trx.raw('select 1')
    try {
      await trx.commit()
    } catch (err) {
      seen = err
    }
  }
  expect(seen).toBe(failure)
  await db.destroy()
})

test('a successful commit still resolves, and the callback form still reports a failed COMMIT', async () => {
  // The other half of the fix: surfacing the swallowed error must not invent
  // one. A healthy `commit()` resolves, and the callback form — which already
  // propagated correctly before — keeps doing so rather than being rerouted
  // into knex's `.catch(err => transactor.rollback(err))` branch.
  const healthy = createFakeAdapter({ dialect: 'mysql' })
  const dbHealthy = createKnexClient(healthy.adapter)
  const trx = await dbHealthy.transaction()
  await trx.raw('select 1')
  await expect(trx.commit()).resolves.not.toThrow()
  // The exact statement sequence, not just "a COMMIT happened": this is what
  // makes the fix free on the working path. Surfacing the swallowed error is a
  // promise handler on a promise knex already created — it issues no statement
  // of its own, so a transactor-form transaction still costs exactly three
  // round trips. A future fix that reached for `SAVEPOINT`, a status query, or
  // a second COMMIT attempt would show up here as a fourth entry rather than as
  // an unexplained latency regression against a live database.
  expect(healthy.calls.map((c) => c.sql)).toEqual(['BEGIN;', 'select 1', 'COMMIT;'])
  await dbHealthy.destroy()

  const { adapter } = createFakeAdapter({
    dialect: 'mysql',
    failExecute: (sql) => (/^COMMIT/i.test(sql) ? new Error('commit refused by server') : undefined),
  })
  const db = createKnexClient(adapter)
  await expect(
    db.transaction(async (t) => {
      await t.raw('select 1')
    }),
  ).rejects.toThrow('commit refused by server')
  await db.destroy()
})

test('a failed query the caller already handled does not poison a later successful commit', async () => {
  // The precise scope of what `commit()` now reports. It rejects with whatever
  // knex routed to the transaction's execution promise, and only knex's own
  // BEGIN/COMMIT/ROLLBACK/SAVEPOINT statements go down that path
  // (execution/transaction.js) — a failing *user* query rejects the query's own
  // promise and leaves the transaction alone. So a caller who catches a failed
  // query and commits the rest must still get a resolved `commit()`.
  //
  // This pins that boundary rather than re-testing the fix: it passes for any
  // implementation built on the execution promise, because knex never puts a
  // user query's error there. What it does catch is a future fix rebuilt on a
  // broader signal — remembering the last error `adapter.execute()` threw, say —
  // which would turn every handled query error into a spurious commit
  // rejection, reporting work lost when it landed. Same silent wrongness as the
  // bug, inverted, and the reason the fix reads the execution promise
  // specifically.
  const { adapter, calls } = createFakeAdapter({
    dialect: 'mysql',
    failExecute: (sql) => (/nonexistent/i.test(sql) ? new Error('no such table') : undefined),
  })
  const db = createKnexClient(adapter)
  const trx = await db.transaction()
  await trx.raw('select 1')
  await expect(trx.raw('select * from nonexistent')).rejects.toThrow('no such table')
  await expect(trx.commit()).resolves.not.toThrow()
  expect(calls.some((c) => /^COMMIT/i.test(c.sql))).toBe(true)
  expect(calls.some((c) => /^ROLLBACK/i.test(c.sql))).toBe(false)
  await db.destroy()
})

test('abandoning a transactor whose ROLLBACK fails does not raise an unhandled rejection', async () => {
  // `surfaceFailedCommit` attaches a handler to the execution promise the
  // moment the transactor is created, whether or not the caller ever commits.
  // A rejection nobody consumes is a process-level unhandled rejection, and in
  // a Worker that is an error the request never asked for — so the handler must
  // convert the rejection to a value rather than re-throw. Exercised through
  // `await using`, whose disposal issues the ROLLBACK that fails here.
  const errors: unknown[] = []
  const onUnhandled = (e: unknown) => errors.push(e)
  process.on('unhandledRejection', onUnhandled)
  try {
    const { adapter } = createFakeAdapter({
      dialect: 'mysql',
      failExecute: (sql) => (/^ROLLBACK/i.test(sql) ? new Error('rollback refused by server') : undefined),
    })
    const db = createKnexClient(adapter)
    {
      await using trx = await db.transaction()
      await trx.raw('select 1')
    }
    // One macrotask is where an unhandled rejection is reported: the check is
    // meaningless on the same tick the promise rejects.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await db.destroy()
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
  expect(errors).toEqual([])
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

test('a handle validate() marks stale is evicted and a fresh one acquired on the next query', async () => {
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

test('trx.destroy() inside an open transaction does not tear down the adapter or break the parent db', async () => {
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

test('sqlite: a Date binding reaches execute() as its epoch-ms number, and a boolean as 0/1 (query builder path)', async () => {
  // Matches knex's own better-sqlite3 dialect (node_modules/knex/lib/dialects/
  // better-sqlite3/index.js's `_formatBindings`) exactly, so a knex +
  // better-sqlite3 codebase gets the same stored values migrating to any
  // sqlite-family adapter here.
  const { adapter, calls } = createFakeAdapter({ dialect: 'sqlite' })
  const db = createKnexClient(adapter)
  const when = new Date(1577934245000)
  await db('users').insert({ created_at: when, active: true, inactive: false })
  // knex's insert compiler sorts object keys alphabetically when generating
  // the column list -- `active`, `created_at`, `inactive`, in that order.
  expect(calls[0]?.bindings).toEqual([1, when.valueOf(), 0])
  await db.destroy()
})

test('sqlite: db.raw() bindings are normalized the same way as the query builder (the fix must not miss db.raw())', async () => {
  // `prepBindings` is knex's own hook, reached from lib/raw.js by a different
  // route than the query compiler uses, so covering only the builder above
  // would leave this route untested even though both end in the same
  // `execute()`.
  const { adapter, calls } = createFakeAdapter({ dialect: 'sqlite' })
  const db = createKnexClient(adapter)
  const when = new Date(1577934245000)
  await db.raw('select ?, ? as v', [when, true])
  expect(calls[0]?.bindings).toEqual([when.valueOf(), 1])
  await db.destroy()
})

test('mysql/postgres: a Date and a boolean binding reach execute() unchanged -- the sqlite conversion must not leak into other dialects', async () => {
  // The isolation half of the fix: converting a Date to a number for mysql
  // or postgres would corrupt every timestamp column, since both drivers
  // accept Date/boolean natively and encode them correctly for their own
  // column types.
  for (const dialect of ['mysql', 'postgres'] as const) {
    const { adapter, calls } = createFakeAdapter({
      dialect,
      // postgres's response guard (src/core/response.ts) requires a
      // `command` field on every result -- unrelated to what this test
      // actually checks (the bindings array), but needed for the insert to
      // resolve instead of throwing a malformed-result error.
      result: dialect === 'postgres' ? { command: 'INSERT' } : {},
    })
    const db = createKnexClient(adapter)
    const when = new Date(1577934245000)
    await db('users').insert({ created_at: when, active: true })
    // Alphabetical column order again -- `active`, `created_at`.
    expect(calls[0]?.bindings).toEqual([true, when])
    expect(calls[0]?.bindings?.[1]).toBeInstanceOf(Date)
    await db.destroy()
  }
})

test('sqlite: a bigint binding passes through unconverted (matches better-sqlite3, which does not convert it either)', async () => {
  // Measured: D1's real binding throws D1_TYPE_ERROR on a bigint the same
  // way it used to on Date (test/unit/d1.test.ts pins this against the real
  // binding), but knex's own better-sqlite3 dialect -- the reference this
  // project's sqlite-path conversion matches -- doesn't convert bigint
  // either, so this deliberately isn't widened beyond that reference.
  const { adapter, calls } = createFakeAdapter({ dialect: 'sqlite' })
  const db = createKnexClient(adapter)
  await db.raw('select ? as v', [42n])
  expect(calls[0]?.bindings).toEqual([42n])
  await db.destroy()
})

test('sqlite: Uint8Array/ArrayBuffer bindings pass through unconverted (accepted correctly by every sqlite-family backend today)', async () => {
  // Measured live against D1 (miniflare), the docker libsql-server, and live
  // Turso: all three accept a Uint8Array or ArrayBuffer binding as-is and
  // round-trip its bytes correctly, matching better-sqlite3's own
  // `_formatBindings`, which also leaves both untouched. Nothing to fix.
  const { adapter, calls } = createFakeAdapter({ dialect: 'sqlite' })
  const db = createKnexClient(adapter)
  const bytes = new Uint8Array([1, 2, 3])
  const buffer = new ArrayBuffer(4)
  await db.raw('select ?, ? as v', [bytes, buffer])
  expect(calls[0]?.bindings).toEqual([bytes, buffer])
  await db.destroy()
})

// `hardenMigrationAccessors` (src/core/client.ts) exists because real
// wrangler/esbuild honours knex's `package.json` `browser` field and
// substitutes a no-op for `Migrator`/`Seeder`, which makes `db.migrate`/
// `db.seed` throw a bare `TypeError: Migrator is not a constructor` at
// property-access time in a deployed Worker --
// `@cloudflare/vitest-pool-workers` does not honour that field, so that
// specific failure cannot be reproduced by calling `createKnexClient(...)`
// in this repo. These tests drive the extracted function directly against a
// plain object carrying the same accessor shape instead. (For the
// complementary "the real class loads and behaves normally in this pool"
// case, see test/unit/migrate.test.ts's `db.migrate`/`db.seed` tests --
// deliberately not restated here.)
test('hardenMigrationAccessors: a TypeError from the getter becomes a CfKnexError naming the capability', () => {
  const target = {
    get migrate(): unknown {
      throw new TypeError('Migrator is not a constructor')
    },
  }
  hardenMigrationAccessors(target)
  try {
    void target.migrate
    throw new Error('expected target.migrate to throw')
  } catch (err) {
    expect(err).toBeInstanceOf(CfKnexError)
    expect((err as CfKnexError).code).toBe('UNSUPPORTED_CAPABILITY')
    // Matched against the capability's own leading phrase, not a bare
    // `.toContain('migrate')` -- the hint text below also mentions
    // "migrations/seeds" in prose, so a looser substring check here would
    // still pass even if the capability argument itself were dropped or
    // swapped.
    expect((err as CfKnexError).message).toMatch(/^db\.migrate is not available/)
  }
})

test('hardenMigrationAccessors: hardens seed the same way as migrate, not only migrate', () => {
  const target = {
    get seed(): unknown {
      throw new TypeError('Seeder is not a constructor')
    },
  }
  hardenMigrationAccessors(target)
  try {
    void target.seed
    throw new Error('expected target.seed to throw')
  } catch (err) {
    expect(err).toBeInstanceOf(CfKnexError)
    expect((err as CfKnexError).code).toBe('UNSUPPORTED_CAPABILITY')
    // Same reasoning as the migrate test above -- the hint text's own prose
    // mentions "seeds", so this is matched against the leading phrase, not a
    // bare substring check.
    expect((err as CfKnexError).message).toMatch(/^db\.seed is not available/)
  }
})

test('hardenMigrationAccessors: a getter that succeeds still returns its value, through the correct `this`', () => {
  const target = {
    marker: 'ok',
    get migrate(): unknown {
      // Reads `this` deliberately -- a wrapper that calls the original
      // getter without preserving `this` (e.g. `originalGet()` instead of
      // `originalGet.call(this)`) would still pass a version of this test
      // that only checked the return value against a `this`-independent
      // getter.
      return this.marker
    },
  }
  hardenMigrationAccessors(target)
  expect(target.migrate).toBe('ok')
})

test('hardenMigrationAccessors: a getter that builds a fresh value on every access keeps doing so through the wrapper', () => {
  let calls = 0
  const target = {
    get migrate(): unknown {
      calls++
      return { call: calls }
    },
  }
  hardenMigrationAccessors(target)
  expect(target.migrate).toEqual({ call: 1 })
  expect(target.migrate).toEqual({ call: 2 })
})

test('hardenMigrationAccessors: a non-TypeError from the getter propagates unchanged', () => {
  const boom = new RangeError('boom')
  const target = {
    get migrate(): unknown {
      throw boom
    },
  }
  hardenMigrationAccessors(target)
  try {
    void target.migrate
    throw new Error('expected target.migrate to throw')
  } catch (err) {
    expect(err).toBe(boom)
  }
})

test('hardenMigrationAccessors: the property stays configurable and an accessor, never a data property', () => {
  const target = {
    get migrate(): unknown {
      return 'value'
    },
  }
  hardenMigrationAccessors(target)
  const descriptor = Object.getOwnPropertyDescriptor(target, 'migrate')
  expect(descriptor?.configurable).toBe(true)
  expect(typeof descriptor?.get).toBe('function')
  expect(descriptor?.value).toBeUndefined()
})

// knex's `browser` field substitution happens when the Worker is bundled,
// before a driver is ever chosen, so this failure is identical on all five
// drivers. An earlier version of this message opened by blaming whichever
// driver the caller had picked, which points them at the one thing that
// cannot help. `sqlite3` is the probe token because -- unlike `d1` or
// `libsql` -- it appears nowhere in the hint's own prose, so this assertion
// fails the moment driver attribution comes back.
test('hardenMigrationAccessors: the message does not attribute the failure to whichever driver is in use', () => {
  const target = {
    client: { driverName: 'sqlite3' },
    get migrate(): unknown {
      throw new TypeError('Migrator is not a constructor')
    },
  }
  hardenMigrationAccessors(target)
  expect(() => target.migrate).toThrowError(CfKnexError)
  expect(() => target.migrate).not.toThrowError(/sqlite3/)
})
