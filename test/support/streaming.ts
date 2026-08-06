import type { Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

// Large enough to force each adapter's own internal batching to run more
// than once: src/adapters/pg.ts's `stream()` FETCHes 100 rows per round
// trip (`FETCH_BATCH_SIZE`), and mysql2's `stream()` hands back a Readable
// in the usual small object-mode highWaterMark. A single-digit row count
// would only ever exercise the trivial one-batch case on either adapter.
export const ROW_COUNT = 250

// Extracted here (rather than staying local to test/integration/streaming.ts)
// so a second dialect's own test file can register the same battery of
// streaming assertions against its own connection instead of hand-copying
// them into a parallel implementation.
export function runStreamingSuite(name: string, factory: () => Knex) {
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

    // Named for exactly what this asserts — row count and order — and
    // nothing stronger. It does *not* prove the underlying adapter used a
    // real server-side cursor/incremental readable rather than buffering
    // the whole result before trickling it out one row at a time; a fully
    // buffered implementation would pass this test identically. See
    // `streaming: pg adapter regression coverage` in
    // test/integration/streaming.test.ts for a test that actually
    // distinguishes the two, by inspecting the SQL pg's adapter issues
    // rather than only the rows the caller ends up seeing.
    test(`streams all ${ROW_COUNT} rows, in order, with none missing or duplicated`, async () => {
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

    // Named for exactly what this covers — the query fails before the very
    // first row would ever be produced (the table doesn't exist, so nothing
    // downstream of `_stream()`'s own error-propagation path — backpressure,
    // drain, close-classification — is ever exercised; the very first
    // `rows.next()` call rejects immediately). A weaker claim than "a query
    // that fails" suggests: `streaming: pg adapter regression coverage` in
    // test/integration/streaming.test.ts adds the case this doesn't cover, a
    // failure that lands only after real rows already crossed the wire.
    test('a query that fails at the database before yielding any row rejects instead of hanging or silently yielding nothing', async () => {
      await expect(async () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars -- iterated purely to prove the loop body is never reached
        for await (const _row of db('cf_knex_table_does_not_exist_xyz').stream()) {
          throw new Error('unreachable: should have rejected before yielding any row')
        }
      }).rejects.toThrow()
    })
  })
}
