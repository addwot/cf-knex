import { expect, test } from 'vitest'
import { createTidbHttpAdapter } from '../../src/adapters/tidb-http'
import { createKnexClient } from '../../src/core/client'
import { runConformanceSuite } from '../support/conformance'

// Same placeholder-instead-of-silence rule as test/integration/mysql2.test.ts:
// a missing URL must read as "not run here", never as a pass and never as a
// failure, and the file must still register a suite either way.
function skip(name: string, envVar: string) {
  test.skip(`${name} (${envVar} not set)`, () => {})
}

if (process.env.TIDB_URL) {
  const url = process.env.TIDB_URL

  runConformanceSuite('tidb-http (TiDB Cloud Serverless)', () => createKnexClient(createTidbHttpAdapter({ url })), {
    streaming: false,
    transactions: true,
  })

  // TiDB's HTTP response carries `lastInsertId` as a decimal *string*, which
  // this adapter widens to a bigint — where mysql2 over TCP hands back a
  // number for the same insert. The divergence is real and user-visible, so
  // it is pinned here rather than left to be discovered downstream.
  test('insertId comes back as a bigint, where mysql2 gives a number', async () => {
    const db = createKnexClient(createTidbHttpAdapter({ url }))
    const table = `cf_knex_${Math.random().toString(36).slice(2, 10)}`
    try {
      await db.schema.createTable(table, (t) => {
        t.increments('id')
        t.string('name')
      })
      const [id] = await db(table).insert({ name: 'a' })
      expect(typeof id).toBe('bigint')
    } finally {
      await db.schema.dropTableIfExists(table)
      await db.destroy()
    }
  })

  test('a nested transaction rolls back independently of its parent (savepoint path)', async () => {
    const db = createKnexClient(createTidbHttpAdapter({ url }))
    const table = `cf_knex_${Math.random().toString(36).slice(2, 10)}`
    try {
      await db.schema.createTable(table, (t) => {
        t.increments('id')
        t.string('name')
      })

      await db.transaction(async (trx) => {
        await trx(table).insert({ name: 'nest-outer' })
        await expect(
          trx.transaction(async (trx2) => {
            await trx2(table).insert({ name: 'nest-inner' })
            throw new Error('nested rollback')
          }),
        ).rejects.toThrow('nested rollback')
      })

      expect(await db(table).where('name', 'nest-outer').first()).toBeTruthy()
      expect(await db(table).where('name', 'nest-inner').first()).toBeFalsy()
    } finally {
      await db.schema.dropTableIfExists(table)
      await db.destroy()
    }
  })

  // Regression test: before `execute()` learned
  // to intercept BEGIN, `db.raw('BEGIN')` ran as an ordinary statement on
  // the handle knex already held, permanently poisoning it — every later
  // query on that same handle failed with "Transaction connection not
  // found, invalid session or the transaction has been closed/cleaned", and
  // with no `validate()`, the pool kept handing that dead handle back out.
  // `pool: { max: 1 }` forces every acquire below onto the exact same
  // handle, so this deterministically exercises the poisoned-handle path
  // rather than happening to land on a fresh one.
  test('db.raw(BEGIN) followed by ordinary queries does not poison the connection (regression)', async () => {
    const db = createKnexClient(createTidbHttpAdapter({ url }), { pool: { min: 0, max: 1 } })
    const table = `cf_knex_${Math.random().toString(36).slice(2, 10)}`
    try {
      await db.schema.createTable(table, (t) => {
        t.increments('id')
        t.string('name')
      })

      await db.raw('BEGIN')
      await db(table).insert({ name: 'raw-begin' })
      await db.raw('COMMIT')

      expect(await db(table).where('name', 'raw-begin').first()).toBeTruthy()
      // A later, ordinary query on the same (single-connection) pool must
      // still work — this is the assertion the original bug failed.
      expect(await db(table).count('* as count').first()).toBeTruthy()
    } finally {
      await db.schema.dropTableIfExists(table)
      await db.destroy()
    }
  })

  test('an unsupported isolation level throws rather than being silently ignored', async () => {
    const db = createKnexClient(createTidbHttpAdapter({ url }))
    try {
      await expect(db.transaction(async () => {}, { isolationLevel: 'serializable' })).rejects.toMatchObject({
        code: 'UNSUPPORTED_TRANSACTION_MODE',
      })
    } finally {
      await db.destroy()
    }
  })

  test('SET TRANSACTION READ ONLY throws rather than being silently ignored', async () => {
    const db = createKnexClient(createTidbHttpAdapter({ url }))
    try {
      await expect(db.transaction(async () => {}, { readOnly: true })).rejects.toMatchObject({
        code: 'UNSUPPORTED_TRANSACTION_MODE',
      })
      // Pins the wording, not just the code: falling through to the generic
      // unsupported-isolation-level branch instead of the dedicated
      // READ-ONLY one would still throw the same code with different text.
      await expect(db.transaction(async () => {}, { readOnly: true })).rejects.toThrow(/no equivalent/i)
    } finally {
      await db.destroy()
    }
  })
} else {
  skip('tidb-http (TiDB Cloud Serverless)', 'TIDB_URL')
}
