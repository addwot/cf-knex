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

    // Named for exactly what this asserts — row count and order — and
    // nothing stronger. It does *not* prove the underlying adapter used a
    // real server-side cursor/incremental readable rather than buffering
    // the whole result before trickling it out one row at a time; a fully
    // buffered implementation would pass this test identically. See
    // `streaming: pg adapter regression coverage` below for a test that
    // actually distinguishes the two, by inspecting the SQL pg's adapter
    // issues rather than only the rows the caller ends up seeing.
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
    // that fails" suggests: `streaming: pg adapter regression coverage`
    // below adds the case this doesn't cover, a failure that lands only
    // after real rows already crossed the wire.
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

// Round-3 review regression coverage — Findings 1, 4 and 5 (see the fix-round
// section of task-13-report.md for the full writeup). Each of these was
// reproduced live against pure knex/tarn/pg (Findings 1/4) or by direct
// experimentation with Node's stream semantics (Finding 3, covered instead
// in test/unit/client.test.ts since it's about src/core/client.ts, not this
// adapter) before being fixed — these tests exercise the actual shipped
// src/adapters/pg.ts and src/core/client.ts code the scratchpad probes could
// only stand in for, against a real container.
if (process.env.POSTGRES_URL) {
  const url = process.env.POSTGRES_URL

  describe('streaming: pg adapter regression coverage (Findings 1, 4, 5)', () => {
    let db: Knex
    const table = `cf_knex_stream_regress_${Math.random().toString(36).slice(2, 10)}`
    const overlapTable = `cf_knex_stream_overlap_${Math.random().toString(36).slice(2, 10)}`

    beforeAll(async () => {
      db = createKnexClient(createPgAdapter({ url }))
      await db.schema.createTable(table, (t) => {
        t.increments('id')
        t.string('label')
      })
      await db(table).insert(Array.from({ length: ROW_COUNT }, (_, i) => ({ label: `row-${i}` })))

      await db.schema.createTable(overlapTable, (t) => {
        t.increments('id')
        t.string('label')
      })
      await db(overlapTable).insert([
        ...Array.from({ length: 10 }, (_, i) => ({ label: `a-${i}` })),
        ...Array.from({ length: 10 }, (_, i) => ({ label: `b-${i}` })),
      ])
    })

    afterAll(async () => {
      await db.schema.dropTableIfExists(table)
      await db.schema.dropTableIfExists(overlapTable)
      await db.destroy()
    })

    // Finding 1: knex's `Runner.stream()` has a second, earlier connection-
    // release path (the output Transform's own 'close' handler) that fires
    // the instant a consumer stops early, with no dependency on whether
    // stream()'s own CLOSE/ROLLBACK-TO-SAVEPOINT/COMMIT cleanup has even
    // started. src/adapters/pg.ts's `handlesMidTeardown` set closes that
    // race by making `validate()` refuse to hand the connection back out
    // for that entire span. Driven directly against the adapter's own
    // `acquire()`/`stream()`/`validate()` (not through knex/tarn at all) so
    // this is deterministic rather than timing-dependent — the live,
    // timing-based reproduction against real knex+tarn+pg lives in the
    // fix-round scratchpad probes, not here, since a `for await … break`'s
    // exact race window can't be pinned down reliably inside a test
    // assertion.
    test('validate() reports a handle invalid for the entire span stream() is still tearing it down after an early exit (Finding 1 regression)', async () => {
      const adapter = createPgAdapter({ url })
      const handle = await adapter.acquire()

      const iterator = adapter.stream!(handle, `select id from ${table} order by id`, [])[Symbol.asyncIterator]()
      const first = await iterator.next()
      expect(first.done).toBe(false)

      // The same abandonment `for await … break` triggers via IteratorClose
      // — called directly here (not awaited yet) so the assertion right
      // after observes validate()'s answer *during* teardown, not only its
      // already-finished outcome.
      const closed = iterator.return!(undefined)
      expect(adapter.validate!(handle)).toBe(false)

      await closed
      expect(adapter.validate!(handle)).toBe(true)

      await adapter.release(handle)
    })

    // Finding 5 (the first of the two under-asserting tests flagged in
    // review): proves stream() genuinely paginates through a server-side
    // cursor rather than buffering the whole result and trickling it out —
    // the property the old, differently-named test up in `runStreamingSuite`
    // claimed but never actually checked. Verified by spying on the raw
    // connection's own `query()` calls (the same public method `execute()`
    // and `stream()` both call), which a purely row-counting/ordering
    // assertion has no way to see.
    test('stream() fetches rows through a real server-side cursor in bounded batches, not one buffered SELECT (Finding 5 regression)', async () => {
      const adapter = createPgAdapter({ url })
      const handle = (await adapter.acquire()) as unknown as {
        query: (sql: string, values?: unknown[]) => Promise<unknown>
      }
      const originalQuery = handle.query.bind(handle)
      const issued: string[] = []
      handle.query = (sql: string, values?: unknown[]) => {
        issued.push(sql)
        return originalQuery(sql, values)
      }

      const rows: unknown[] = []
      for await (const row of adapter.stream!(handle, `select id from ${table} order by id`, [])) {
        rows.push(row)
      }
      expect(rows).toHaveLength(ROW_COUNT)

      const declares = issued.filter((s) => s.startsWith('DECLARE') && s.includes('CURSOR FOR'))
      const fetches = issued.filter((s) => s.startsWith('FETCH'))
      expect(declares).toHaveLength(1)
      // FETCH_BATCH_SIZE is 100 (src/adapters/pg.ts) and this table has 250
      // rows, so a real cursor takes more than one round trip to exhaust it
      // — a single buffered `SELECT` would need exactly zero `FETCH` calls.
      expect(fetches.length).toBeGreaterThan(1)
      // And the query text pg's adapter issues as its own top-level
      // statements never includes a bare, unwrapped `select …` — only ever
      // wrapped inside `DECLARE … CURSOR FOR …`.
      expect(issued.some((s) => /^select id from/i.test(s))).toBe(false)

      await adapter.release(handle)
    })

    // Finding 5 (the second under-asserting test): the existing "fails at
    // the database" test up in `runStreamingSuite` only covers a query that
    // fails before any row could possibly be yielded — the version of this
    // that never exercises anything downstream of the very first `FETCH`.
    // This one fails inside the *second* cursor batch (FETCH_BATCH_SIZE is
    // 100, and the poison expression divides by zero only at id 150), so
    // some real rows must already have crossed the wire before the
    // rejection — proving `_stream()`/knex's Transform propagate a mid-
    // stream failure correctly rather than silently truncating the output.
    test('a query that fails partway through, after already yielding rows from earlier batches, still rejects rather than silently stopping (Finding 5 regression)', async () => {
      const seen: unknown[] = []
      await expect(async () => {
        for await (const row of db(table)
          .select(db.raw('id, 1 / (id - 150) as ratio'))
          .orderBy('id')
          .stream()) {
          seen.push(row)
        }
      }).rejects.toThrow()
      expect(seen.length).toBeGreaterThan(0)
      expect(seen.length).toBeLessThan(ROW_COUNT)
    })

    // Finding 4: two overlapping, unawaited `.stream()` calls sharing one
    // connection (nothing stops a caller starting a second `trx(t2).stream()`
    // before awaiting the first, inside one `db.transaction()` callback)
    // each get their own nested SAVEPOINT. The shipped code no longer issues
    // an explicit `RELEASE SAVEPOINT` on the success path (see
    // src/adapters/pg.ts's `stream()` comment for why that specifically was
    // the bug — postgres's own cascading release semantics turned the
    // *first* stream to finish's cleanup into a landmine for every other
    // still-open sibling). Driven through the real query builder and a real
    // `db.transaction()`, manually interleaved so both generators are
    // genuinely open on the same connection at once rather than one
    // exhausting before the other starts.
    test('two overlapping streams inside one db.transaction() do not corrupt each other via savepoint cascade (Finding 4 regression)', async () => {
      const rowsA: unknown[] = []
      const rowsB: unknown[] = []

      await db.transaction(async (trx) => {
        const iterA = trx(overlapTable).where('label', 'like', 'a-%').stream()[Symbol.asyncIterator]()
        const iterB = trx(overlapTable).where('label', 'like', 'b-%').stream()[Symbol.asyncIterator]()

        let a = await iterA.next()
        let b = await iterB.next()
        while (!a.done || !b.done) {
          if (!a.done) {
            rowsA.push(a.value)
            a = await iterA.next()
          }
          if (!b.done) {
            rowsB.push(b.value)
            b = await iterB.next()
          }
        }
      })

      expect(rowsA).toHaveLength(10)
      expect(rowsB).toHaveLength(10)
      // The transaction's own COMMIT must have gone through cleanly —
      // Finding 4's bug corrupted the shared connection into a permanently
      // aborted transaction (SQLSTATE 25P02) once the earlier-finishing
      // stream's cascading `RELEASE SAVEPOINT` pulled the rug out from
      // under the still-open sibling, which `db.transaction()` itself would
      // have surfaced as a rejection rather than a clean commit.
      const count = await db(overlapTable).count('* as count').first()
      expect(Number((count as { count: number }).count)).toBe(20)
    })
  })
} else {
  skip('pg adapter regression coverage (Findings 1, 4, 5)', 'POSTGRES_URL')
}
