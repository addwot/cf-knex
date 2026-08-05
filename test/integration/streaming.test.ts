import type { Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createMysql2Adapter } from '../../src/adapters/mysql2'
import { createPgAdapter } from '../../src/adapters/pg'
import { createKnexClient } from '../../src/core/client'

// Same reasoning as test/integration/mysql2.test.ts's `skip()`: every suite
// below is conditional on a connection URL, so with no database configured
// this file would register zero tests, and vitest fails a file with no
// suite outright ("No test suite found in file"). A named `test.skip`
// placeholder keeps the file always a valid suite and states which env var
// was missing.
function skip(name: string, envVar: string) {
  test.skip(`${name} (${envVar} not set)`, () => {})
}

// Large enough to force each adapter's own internal batching to run more
// than once: src/adapters/pg.ts's `stream()` FETCHes 100 rows per round
// trip (`FETCH_BATCH_SIZE`), and mysql2's `stream()` hands back a Readable
// in the usual small object-mode highWaterMark. A single-digit row count
// would only ever exercise the trivial one-batch case on either adapter.
const ROW_COUNT = 250

function runStreamingSuite(name: string, factory: () => Knex) {
  describe(`streaming: ${name}`, () => {
    let db: Knex
    const table = `cf_knex_stream_${Math.random().toString(36).slice(2, 10)}`

    beforeAll(async () => {
      db = factory()
      await db.schema.createTable(table, (t) => {
        t.increments('id')
        t.string('label')
      })
      const rows = Array.from({ length: ROW_COUNT }, (_, i) => ({ label: `row-${i}` }))
      await db(table).insert(rows)
    })

    afterAll(async () => {
      await db.schema.dropTableIfExists(table)
      await db.destroy()
    })

    test(`streams all ${ROW_COUNT} rows, in order, through a real cursor/readable rather than one buffered result`, async () => {
      const seen: number[] = []
      for await (const row of db(table).orderBy('id').stream()) {
        seen.push((row as { id: number }).id)
      }
      expect(seen).toHaveLength(ROW_COUNT)
      expect(seen).toEqual([...seen].sort((a, b) => a - b))
    })

    test('breaking out of the stream early does not hang, and leaves the connection/pool usable afterward', async () => {
      let count = 0
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- only the count matters here
      for await (const _row of db(table).stream()) {
        count++
        if (count === 5) break
      }
      expect(count).toBe(5)
      // The real-world analogue of src/adapters/mysql2.ts's and
      // src/adapters/pg.ts's own early-exit teardown comments: a `break`
      // here must not leave the connection wedged mid-result-set (mysql2)
      // or a cursor/transaction dangling (pg). Proven by running an
      // unrelated query afterward on the same `db` and getting a correct
      // answer, not a hang or an error.
      const row = await db(table).count('* as count').first()
      expect(Number((row as { count: number }).count)).toBe(ROW_COUNT)
    })

    test('a query that fails at the database rejects instead of hanging or silently yielding nothing', async () => {
      await expect(async () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars -- iterated purely to prove the loop body is never reached
        for await (const _row of db('cf_knex_table_does_not_exist_xyz').stream()) {
          throw new Error('unreachable: should have rejected before yielding any row')
        }
      }).rejects.toThrow()
    })
  })
}

if (process.env.MYSQL_URL) {
  const url = process.env.MYSQL_URL
  runStreamingSuite('mysql2 (direct, MySQL 8)', () => createKnexClient(createMysql2Adapter({ url })))
} else {
  skip('mysql2 (direct, MySQL 8)', 'MYSQL_URL')
}

if (process.env.MARIADB_URL) {
  const url = process.env.MARIADB_URL
  runStreamingSuite('mysql2 (direct, MariaDB 11)', () => createKnexClient(createMysql2Adapter({ url })))
} else {
  skip('mysql2 (direct, MariaDB 11)', 'MARIADB_URL')
}

if (process.env.POSTGRES_URL) {
  const url = process.env.POSTGRES_URL
  runStreamingSuite('pg (direct)', () => createKnexClient(createPgAdapter({ url })))
} else {
  skip('pg (direct)', 'POSTGRES_URL')
}

// pg-specific: the one scenario src/adapters/pg.ts's SAVEPOINT-based
// nested-transaction detection exists for (see that file's `stream()`
// comment) — streaming from *inside* `db.transaction()`, on the same
// connection the transaction itself is using. mysql2 has no equivalent case
// to cover here: it has no cursor/transaction interaction at all, since
// `Query.prototype.stream()` (node_modules/mysql2/lib/commands/query.js)
// streams straight off the connection with no BEGIN of its own, nested or
// not.
if (process.env.POSTGRES_URL) {
  const url = process.env.POSTGRES_URL

  describe('streaming: pg nested-transaction safety', () => {
    let db: Knex
    const table = `cf_knex_stream_nested_${Math.random().toString(36).slice(2, 10)}`

    beforeAll(async () => {
      db = createKnexClient(createPgAdapter({ url }))
      await db.schema.createTable(table, (t) => {
        t.increments('id')
        t.string('label')
      })
    })

    afterAll(async () => {
      await db.schema.dropTableIfExists(table)
      await db.destroy()
    })

    test('streaming inside db.transaction() does not commit the outer transaction early, and a later rollback still rolls it back', async () => {
      let visibleFromOutsideDuringStream: boolean | undefined

      await db
        .transaction(async (trx) => {
          await trx(table).insert({ label: 'nested-marker' })

          const seen: unknown[] = []
          for await (const row of trx(table).where('label', 'nested-marker').stream()) {
            seen.push(row)
          }
          expect(seen).toHaveLength(1)

          // A second, fully independent connection (its own client, its own
          // pool — not sharing anything with `db`) checks visibility while
          // the outer transaction is still open. If `stream()` had issued
          // an unconditional BEGIN and then committed *that* transaction
          // once the cursor was exhausted — the bug the SAVEPOINT-based
          // nested-transaction check exists to prevent — this row would
          // already be durably visible here, before the callback below has
          // even decided to roll back.
          const outsideDb = createKnexClient(createPgAdapter({ url }))
          const visible = await outsideDb(table).where('label', 'nested-marker').first()
          visibleFromOutsideDuringStream = !!visible
          await outsideDb.destroy()

          throw new Error('rollback-on-purpose')
        })
        .catch((err) => {
          if ((err as Error).message !== 'rollback-on-purpose') throw err
        })

      expect(visibleFromOutsideDuringStream).toBe(false)
      // And the outer transaction's own rollback must still have taken
      // effect normally afterward — proving the stream's cursor teardown
      // (RELEASE SAVEPOINT, not COMMIT, since it detected an already-open
      // transaction) did not itself commit anything early either.
      expect(await db(table).where('label', 'nested-marker').first()).toBeFalsy()
    })
  })
} else {
  skip('pg nested-transaction safety', 'POSTGRES_URL')
}
