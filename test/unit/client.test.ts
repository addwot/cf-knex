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
})

test('.first() returns a row, not an array (Defect A regression)', async () => {
  const { adapter } = createFakeAdapter({ dialect: 'mysql', result: { rows: [{ id: 1, tags: 'a,b' }] } })
  const db = createKnexClient(adapter)
  const row = await db('videos').first()
  expect(row).toEqual({ id: 1, tags: 'a,b' })
  expect(Array.isArray(row)).toBe(false)
})

test('.insert() returns the insert id (Defect B regression)', async () => {
  const { adapter } = createFakeAdapter({ dialect: 'mysql', result: { rows: [], insertId: 99 } })
  const db = createKnexClient(adapter)
  expect(await db('users').insert({ name: 'x' })).toEqual([99])
})

test('.update() returns the affected row count', async () => {
  const { adapter } = createFakeAdapter({ dialect: 'mysql', result: { rows: [], affectedRows: 4 } })
  const db = createKnexClient(adapter)
  expect(await db('users').where('id', 1).update({ name: 'y' })).toBe(4)
})

test('postgres selects return rows', async () => {
  const { adapter } = createFakeAdapter({ dialect: 'postgres', result: { rows: [{ id: 1 }], command: 'SELECT' } })
  const db = createKnexClient(adapter)
  expect(await db('users').select('*')).toEqual([{ id: 1 }])
})

test('sqlite inserts return lastID', async () => {
  const { adapter } = createFakeAdapter({ dialect: 'sqlite', result: { rows: [], insertId: 5 } })
  const db = createKnexClient(adapter)
  expect(await db('users').insert({ name: 'x' })).toEqual([5])
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

test('caller-supplied knexOptions cannot break the client or the sqlite defaults (precedence regression)', async () => {
  // `connection` must merge with, not replace, the sqlite defaults --
  // omitting `filename` here would otherwise reintroduce the
  // colorette/logger crash documented in src/core/client.ts.
  const { adapter: sqliteAdapter } = createFakeAdapter({ dialect: 'sqlite' })
  expect(() => createKnexClient(sqliteAdapter, { connection: {} })).not.toThrow()

  // `client` must always be `CfKnexClient` -- a caller-supplied `client`
  // must not replace it, or every adapter call stops working.
  const { adapter, calls } = createFakeAdapter({ dialect: 'mysql' })
  class NotOurClient {}
  const db = createKnexClient(adapter, { client: NotOurClient })
  await db('users').where('id', 1).select('name')
  expect(calls[0]?.sql).toBe('select `name` from `users` where `id` = ?')
})
