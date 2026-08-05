import { expect, test } from 'vitest'
import { createKnexClient } from '../../src/core/client'
import { CfKnexError } from '../../src/core/errors'
import { createFakeAdapter } from '../support/fake-adapter'

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
