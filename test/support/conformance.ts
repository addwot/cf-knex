import type { Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
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
    } else {
      test('transaction throws a documented CfKnexError', async () => {
        await expect(db.transaction(async () => {})).rejects.toThrow(/not supported/i)
      })
    }
  })
}
