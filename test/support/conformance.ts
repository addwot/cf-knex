import type { Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { CfKnexError } from '../../src/core/errors'
import type { AdapterCapabilities } from '../../src/core/types'

export function runConformanceSuite(name: string, factory: () => Knex, caps: AdapterCapabilities) {
  describe(`conformance: ${name}`, () => {
    let db: Knex
    const table = `cf_knex_${Math.random().toString(36).slice(2, 10)}`

    beforeAll(async () => {
      db = factory()
      await db.schema.createTable(table, (t) => {
        t.increments('id')
        t.string('name')
        t.integer('score').nullable()
      })
    })

    afterAll(async () => {
      await db.schema.dropTableIfExists(table)
      await db.destroy()
    })

    test('insert returns an id', async () => {
      const [id] = await db(table).insert({ name: 'alice', score: 1 })
      expect(Number(id)).toBeGreaterThan(0)
    })

    test('select returns an array of rows', async () => {
      await db(table).insert({ name: 'bob', score: 2 })
      const rows = await db(table).where('name', 'bob').select('name')
      expect(Array.isArray(rows)).toBe(true)
      expect(rows[0]).toMatchObject({ name: 'bob' })
    })

    test('first returns a single row object, not an array', async () => {
      await db(table).insert({ name: 'carol', score: 3 })
      const row = await db(table).where('name', 'carol').first()
      expect(Array.isArray(row)).toBe(false)
      expect(row).toMatchObject({ name: 'carol' })
    })

    test('count().first() exposes the count', async () => {
      const row = await db(table).count('* as count').first()
      expect(Number((row as { count: number }).count)).toBeGreaterThan(0)
    })

    test('update returns the affected row count', async () => {
      await db(table).insert({ name: 'dave', score: 4 })
      expect(await db(table).where('name', 'dave').update({ score: 5 })).toBe(1)
    })

    test('delete returns the affected row count', async () => {
      await db(table).insert({ name: 'erin', score: 6 })
      expect(await db(table).where('name', 'erin').del()).toBe(1)
    })

    test('null round-trips', async () => {
      await db(table).insert({ name: 'frank', score: null })
      const row = await db(table).where('name', 'frank').first()
      expect((row as { score: number | null }).score).toBeNull()
    })

    if (caps.transactions) {
      test('transaction commits', async () => {
        await db.transaction(async (trx) => { await trx(table).insert({ name: 'grace', score: 7 }) })
        expect(await db(table).where('name', 'grace').first()).toBeTruthy()
      })

      test('transaction rolls back', async () => {
        await expect(db.transaction(async (trx) => {
          await trx(table).insert({ name: 'heidi', score: 8 })
          throw new Error('rollback')
        })).rejects.toThrow('rollback')
        expect(await db(table).where('name', 'heidi').first()).toBeFalsy()
      })

      // Every case above is purely sequential: BEGIN, INSERT, ROLLBACK, then
      // (only afterwards) a SELECT. A single connection reused for both the
      // transaction and the "unrelated" work is indistinguishable from a
      // correctly isolated one under that ordering, because MySQL-family
      // databases return to clean autocommit after ROLLBACK either way —
      // there is nothing left uncommitted for a later SELECT to trip over.
      // This case instead holds the transaction open (via `gate`) and issues
      // an unrelated write from the *same* knex instance while it is still
      // uncommitted, which only comes out correctly if that write reaches
      // its own, separate connection.
      test('a concurrent write outside an open transaction is not swallowed by its rollback', async () => {
        let releaseGate: () => void = () => {}
        const gate = new Promise<void>((resolve) => {
          releaseGate = resolve
        })

        const trxPromise = db.transaction(async (trx) => {
          await trx(table).insert({ name: 'ivan-inside', score: 9 })
          await gate
          throw new Error('rollback')
        })

        // Give the transaction above a chance to actually acquire its own
        // connection and issue BEGIN + the insert before the concurrent
        // write below runs. There is no external signal for "the
        // transaction has started" to wait on instead — waiting for the
        // inside row to become visible would only work under the very bug
        // this case exists to catch (a shared connection sees its own
        // uncommitted write) and would hang forever under a correct,
        // isolated implementation.
        await new Promise((resolve) => setTimeout(resolve, 50))

        await db(table).insert({ name: 'ivan-outside', score: 10 })
        releaseGate()

        await expect(trxPromise).rejects.toThrow('rollback')
        expect(await db(table).where('name', 'ivan-inside').first()).toBeFalsy()
        // The assertion a shared connection fails: with one session for
        // both the transaction and this insert, the insert either lands
        // inside the still-open transaction (and vanishes with the
        // rollback) or blocks until the rollback releases a lock it should
        // never have needed to wait on. Either way this row is missing.
        expect(await db(table).where('name', 'ivan-outside').first()).toBeTruthy()
      })
    } else {
      test('transaction throws a documented CfKnexError', async () => {
        await expect(db.transaction(async () => {})).rejects.toThrow(/not supported/i)
        try {
          await db.transaction(async () => {})
          throw new Error('expected db.transaction() to throw')
        } catch (err) {
          expect(err).toBeInstanceOf(CfKnexError)
          expect((err as CfKnexError).code).toBe('UNSUPPORTED_CAPABILITY')
        }
      })
    }
  })
}
