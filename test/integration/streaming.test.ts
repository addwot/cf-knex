import type { Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createMysql2Adapter } from '../../src/adapters/mysql2'
import { createPgAdapter } from '../../src/adapters/pg'
import { createKnexClient } from '../../src/core/client'
import { CfKnexError } from '../../src/core/errors'

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

// Regression coverage for two mechanisms that are easy to get wrong when
// several `stream()` calls can share one pooled connection: knex's own
// premature connection-release paths racing this adapter's cursor/savepoint
// teardown, and postgres's own savepoint bookkeeping when more than one
// `stream()` is open on the same connection at once. Each test below exists
// because a live reproduction first showed the underlying bug against the
// actual shipped `src/adapters/pg.ts` / `src/core/client.ts` code (not a
// disposable stand-in), then showed the fix closing it.
if (process.env.POSTGRES_URL) {
  const url = process.env.POSTGRES_URL

  describe('streaming: pg premature-release and savepoint-sharing regressions', () => {
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
      // Well beyond both knex's default Transform `highWaterMark` (16,
      // node_modules/knex/lib/execution/runner.js's `Runner.stream()`) and
      // this adapter's own `FETCH_BATCH_SIZE` (100, src/adapters/pg.ts):
      // with only a handful of rows per label, `_stream()`'s own internal
      // write loop (src/core/client.ts) drains the adapter's cursor to
      // completion before a test ever gets to call `.next()` a second time,
      // so there is nothing left "mid-stream" for an early exit to abandon
      // — confirmed empirically: with 10 rows per label, `.return()` below
      // always lands on an already-exhausted generator, a no-op. This many
      // rows keeps every stream below genuinely open (`cursorOpen: true,
      // completed: false`) at the point each test calls `.return()`.
      await db(overlapTable).insert([
        ...Array.from({ length: 300 }, (_, i) => ({ label: `a-${i}` })),
        ...Array.from({ length: 300 }, (_, i) => ({ label: `b-${i}` })),
      ])
    })

    afterAll(async () => {
      await db.schema.dropTableIfExists(table)
      await db.schema.dropTableIfExists(overlapTable)
      await db.destroy()
    })

    // knex's `Runner.stream()` has a second, earlier connection-release path
    // (the output Transform's own 'close' handler) that fires the instant a
    // consumer stops early, with no dependency on whether stream()'s own
    // CLOSE/ROLLBACK-TO-SAVEPOINT/COMMIT cleanup has even started.
    // src/adapters/pg.ts's `handlesMidTeardown` map closes that race by
    // making `validate()` refuse to hand the connection back out for that
    // entire span. Driven directly against the adapter's own
    // `acquire()`/`stream()`/`validate()` (not through knex/tarn at all) so
    // this is deterministic rather than timing-dependent — a cheap unit-
    // level companion to the end-to-end tests below, which drive the same
    // mechanism through real knex/tarn plumbing and a real single-
    // connection pool instead.
    test('validate() reports a handle invalid for the entire span stream() is still tearing it down after an early exit', async () => {
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

    // End-to-end version of the same mechanism, through real knex/tarn
    // plumbing rather than the adapter's own methods called directly. A
    // single-connection pool (`min: 0, max: 1`) means there is only one
    // connection tarn can ever hand out, so if it hands this one to the
    // second, unrelated transaction below before the first `stream()`
    // call's own CLOSE/ROLLBACK-TO-SAVEPOINT/COMMIT cleanup has finished,
    // the two interleave on the same session and corrupt each other —
    // observed directly with `handlesMidTeardown` removed entirely: the
    // interloper transaction's own rollback silently failed to take effect
    // (its insert was still visible afterward, 3/3 runs) because its
    // `BEGIN`/insert/`ROLLBACK` got interleaved on the wire with the
    // abandoned stream's own still-in-flight cleanup queries on that same
    // connection. With the fix, tarn evicts the mid-teardown handle instead
    // of handing it out, a fresh connection serves the interloper, and its
    // rollback behaves normally (5/5 runs).
    test('an early exit does not let a concurrent, unrelated transaction share the connection while cleanup is still in flight', async () => {
      const solo = createKnexClient(createPgAdapter({ url }), { pool: { min: 0, max: 1 } })

      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- only reaching the first row and breaking matters here
      for await (const _row of solo(table).stream()) {
        break
      }

      await solo
        .transaction(async (trx) => {
          await trx(table).insert({ label: 'interloper-rollback' })
          throw new Error('rollback-on-purpose')
        })
        .catch((err) => {
          if ((err as Error).message !== 'rollback-on-purpose') throw err
        })

      const row = await solo(table).where('label', 'interloper-rollback').first()
      expect(row).toBeFalsy()

      await solo.destroy()
    })

    // Same mechanism, but with two overlapping streams sharing one
    // connection instead of one — the case a `Set`-based tracker gets
    // wrong: it can only say "this handle has *a* stream mid-teardown", not
    // "this handle still has one *particular* stream mid-teardown after
    // another has already finished". Observed directly with a `Set` in
    // place of the current `Map<handle, number>`: once stream A's own
    // `finally` block ran and deleted the handle's only entry, `validate()`
    // read `true` again even though sibling stream B's own cleanup was
    // still in flight on the very same connection (3/3 runs) — so once this
    // callback returns (without awaiting B's abandoned cleanup) and the
    // transaction commits, tarn hands the connection straight to the
    // interloper below while B is still issuing queries on it, and the
    // interloper's rollback silently fails to take effect exactly like the
    // single-stream case above. A `Map<handle, number>` — incremented per
    // `stream()` call, decremented per `finally` — reports `false` for as
    // long as *any* stream on the handle is still mid-teardown, closing this
    // specific gap (5/5 runs with the fix).
    test('two overlapping streams: an unrelated transaction must not share the connection while the slower ones cleanup is still in flight', async () => {
      const adapter = createPgAdapter({ url })
      const solo = createKnexClient(adapter, { pool: { min: 0, max: 1 } })
      // Wrapped in try/finally, cleanup unconditional: this test inserts a
      // row into the shared `overlapTable` fixture that the savepoint-
      // cascade test below asserts an exact row count on. A failure partway
      // through here (before the explicit cleanup that used to sit at the
      // end, unguarded) leaked the row and produced a spurious, unrelated
      // failure in that later test.
      try {
        // Getting this to reliably land on the wire in the vulnerable order
        // took a few attempts. The obvious version — drain A, `.next()` once
        // on B, then `.return()` it, both driven through `trx(table).stream()`
        // — never worked: on a fast local connection, B's own abandoned-
        // cleanup `CLOSE` consistently reached the wire before the
        // interloper's `BEGIN` did, regardless of `Set` vs `Map`, because
        // postgres serializes everything on one connection strictly FIFO in
        // JS-call order, and an async generator's `.return()` reaches its own
        // `finally` block (and thus issues `CLOSE`) faster than the outer
        // transaction's commit-then-release-then-acquire chain reaches
        // `BEGIN` — confirmed directly by instrumenting `validate()`/
        // `handlesMidTeardown` while developing this test: the wrong answer
        // genuinely happens, but with that ordering it's never *observable*.
        //
        // Trying to widen the window by leaving B's *next* `FETCH` genuinely
        // unanswered at the moment of abandonment — by consuming exactly
        // `FETCH_BATCH_SIZE` rows first — didn't work either, and not for a
        // subtle reason: `trx(table).stream()` hands back knex's own
        // `Transform` (node_modules/knex/lib/execution/runner.js), and
        // `_stream()` (src/core/client.ts) drains the adapter's generator
        // into it *eagerly*, independent of how many times a test calls
        // `.next()` on the far end — confirmed by instrumenting `stream()`
        // directly: the second `FETCH` for B was already sent, and often
        // already answered, well before a 100-call consumption loop finished,
        // so there was nothing left in flight to abandon into.
        //
        // What actually works: bypass that `Transform` layer and drive
        // `adapter.stream()` directly — still against a connection obtained
        // through a real `db.transaction()`, i.e. `trxClient.acquireConnection()`
        // (node_modules/knex/lib/execution/transaction.js's `makeTxClient`,
        // which just resolves the one connection the transaction already
        // holds — not a separate acquire of a second connection). That is a
        // real knex/tarn connection lifecycle end to end; only the row-by-row
        // pull is driven directly, which is what makes it possible to leave a
        // `FETCH` genuinely unanswered at the exact moment of abandonment.
        // Captured from inside the callback below so the test can wait for
        // B's own abandoned cleanup to genuinely finish before tearing the
        // pool down — otherwise `solo.destroy()` can race B's still-in-flight
        // `FETCH`/`CLOSE` and surface as an unhandled rejection ("Connection
        // terminated") rather than a clean, awaited outcome. Both the
        // in-flight `.next()` this abandons and the `.return()` racing it are
        // captured — either one can be the call still holding an outstanding
        // `FETCH` depending on exactly how the two interleave.
        let bPendingNext: Promise<unknown> = Promise.resolve()
        let bTeardown: Promise<unknown> = Promise.resolve()

        const first = solo.transaction(async (trx) => {
          const handle = await (
            trx.client as unknown as { acquireConnection: () => Promise<unknown> }
          ).acquireConnection()

          const iterA = adapter.stream!(
            handle,
            `select label from ${overlapTable} where label like $1`,
            ['a-%']
          )[Symbol.asyncIterator]()
          const iterB = adapter.stream!(
            handle,
            `select label from ${overlapTable} where label like $1`,
            ['b-%']
          )[Symbol.asyncIterator]()

          // Both genuinely open at once — one row from each, interleaved —
          // rather than one exhausting before the other starts.
          await iterA.next()
          await iterB.next()

          // Exhaust B's first FETCH batch (FETCH_BATCH_SIZE, 100 rows,
          // src/adapters/pg.ts) so the next `.next()` below must issue a
          // fresh one.
          for (let i = 1; i < 100; i++) await iterB.next()

          // Drive A to completion normally...
          let a = await iterA.next()
          while (!a.done) a = await iterA.next()

          // ...then race a genuinely in-flight `FETCH` against abandonment:
          // start B's 101st row (a fresh round trip on the real connection,
          // not yet answered) but don't await it, immediately request
          // `.return()` too, and return without awaiting either — so the
          // outer transaction's own commit is free to proceed while B's
          // cleanup is still queued up behind that outstanding `FETCH`.
          // `.catch()` attached immediately, right here, not merely awaited
          // later by the test: whichever of these two ends up the one still
          // holding the connection open when tarn evicts it (post-fix) or
          // `solo.destroy()` tears it down (pre-fix, once the test's own
          // assertions are done) rejects with "Connection terminated" on a
          // later, unrelated tick — attaching a handler only when the test
          // gets around to `await`-ing it is too late for Node to consider it
          // handled.
          bPendingNext = iterB.next().catch(() => {})
          bTeardown = iterB.return!(undefined).catch(() => {})
        })

        // Started *before* `first` is awaited, not after: with `pool: {min:
        // 0, max: 1}` this queues the interloper's own `acquireConnection`
        // as a pending request on tarn's single resource, so it is handed
        // the connection the instant `Transaction.acquireConnection`'s
        // `finally` releases it — no extra acquire-call round trip in
        // between that would otherwise give B's own abandoned cleanup query
        // extra time to finish first and mask the bug. Reproduced live, with
        // the fix reverted (`Set` in place of `Map`): the interloper's own
        // `insert` itself throws — "current transaction is aborted, commands
        // ignored until end of transaction block" — because B's still-in-
        // flight `FETCH` response lands on the wire *inside* the interloper's
        // own transaction and aborts it (3/3 runs); with the fix, tarn
        // evicts the mid-teardown handle instead of handing it out, a fresh
        // connection serves the interloper, and its insert and commit both
        // succeed normally (3/3 runs).
        const interloper = solo.transaction(async (trx) => {
          await trx(overlapTable).insert({ label: 'interloper-commit' })
        })

        await first
        await interloper

        // Not asserted on: by the time `first` resolves, B's own abandoned
        // cleanup may genuinely still be in flight on a now-committed (and,
        // pre-fix, possibly already handed to the interloper and corrupted)
        // connection — waiting here just avoids tearing the pool down out
        // from under it.
        await Promise.allSettled([bPendingNext, bTeardown])

        const row = await solo(overlapTable).where('label', 'interloper-commit').first()
        expect(row).toBeDefined()
      } finally {
        await solo(overlapTable).where('label', 'interloper-commit').del()
        await solo.destroy()
      }
    })

    // Proves stream() genuinely paginates through a server-side cursor
    // rather than buffering the whole result and trickling it out — the
    // property the differently-named test up in `runStreamingSuite` claims
    // but never actually checks. Verified by spying on the raw connection's
    // own `query()` calls (the same public method `execute()` and
    // `stream()` both call), which a purely row-counting/ordering assertion
    // has no way to see.
    test('stream() fetches rows through a real server-side cursor in bounded batches, not one buffered SELECT', async () => {
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

    // The existing "fails at the database" test up in `runStreamingSuite`
    // only covers a query that fails before any row could possibly be
    // yielded — the version of this that never exercises anything
    // downstream of the very first `FETCH`. This one fails inside the
    // *second* cursor batch (FETCH_BATCH_SIZE is 100, and the poison
    // expression divides by zero only at id 150), so some real rows must
    // already have crossed the wire before the rejection — proving
    // `_stream()`/knex's Transform propagate a mid-stream failure correctly
    // rather than silently truncating the output.
    test('a query that fails partway through, after already yielding rows from earlier batches, still rejects rather than silently stopping', async () => {
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

    // Two overlapping, unawaited `.stream()` calls sharing one connection
    // (nothing stops a caller starting a second `trx(t2).stream()` before
    // awaiting the first, inside one `db.transaction()` callback) each get
    // their own nested SAVEPOINT. The shipped code no longer issues an
    // explicit `RELEASE SAVEPOINT` on the success path (see
    // src/adapters/pg.ts's `stream()` comment for why that specifically was
    // a bug — postgres's own cascading release semantics turned the *first*
    // stream to finish's cleanup into a landmine for every other still-open
    // sibling, when both succeed). Driven through the real query builder and
    // a real `db.transaction()`, manually interleaved so both generators are
    // genuinely open on the same connection at once rather than one
    // exhausting before the other starts. (This covers the both-succeed
    // case only — see src/adapters/pg.ts's `stream()` comment for the
    // separate, currently-unfixed limitation when one overlapping sibling
    // fails instead.)
    test('two overlapping streams inside one db.transaction() do not corrupt each other via savepoint cascade', async () => {
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

      expect(rowsA).toHaveLength(300)
      expect(rowsB).toHaveLength(300)
      // The transaction's own COMMIT must have gone through cleanly. The bug
      // this guards against corrupted the shared connection into a
      // permanently aborted transaction (SQLSTATE 25P02) once the earlier-
      // finishing stream's cascading `RELEASE SAVEPOINT` pulled the rug out
      // from under the still-open sibling, which `db.transaction()` itself
      // would have surfaced as a rejection rather than a clean commit.
      const count = await db(overlapTable).count('* as count').first()
      expect(Number((count as { count: number }).count)).toBe(600)
    })

    // Constructs one specific, reliable way to leave a transaction's
    // connection aborted — sibling B's savepoint created before sibling A's
    // cursor, B fails, its `ROLLBACK TO SAVEPOINT` cascades onto A — purely
    // as a deterministic repro tool, not as a claim about what typically
    // causes this in production. It is not: driven through the public
    // `trx(t).stream()` API instead (a 5,000-row sibling, same shape),
    // sibling A stays healthy and the row persists — this exact cascade is
    // only reachable by driving `adapter.stream()` directly, bypassing
    // knex's Transform, which no real caller does. See the plain,
    // streaming-free regression test below for the shape that actually
    // matters to real users: any swallowed statement error inside a
    // `db.transaction()` callback leaves the connection aborted the same
    // way, no streaming involved.
    //
    // Bypassing the Transform here is also load-bearing for a second reason
    // (same as the premature-release test above): it drains the adapter's
    // generator eagerly in the background, independent of this test's own
    // `.next()` calls, so sibling A's own generator would otherwise race to
    // natural completion before B ever fails. Own table, dropped in this
    // test's own `finally`, so a failure here can't leak a row into the
    // count-based assertion above.
    test('db.transaction() rejects instead of silently committing nothing when its connection is left aborted by a low-level, non-public-API two-cursor cascade', async () => {
      const adapter = createPgAdapter({ url })
      const lossTable = `cf_knex_stream_commit_loss_${Math.random().toString(36).slice(2, 10)}`
      try {
        await db.schema.createTable(lossTable, (t) => {
          t.increments('id')
          t.string('label')
          t.integer('value')
        })
        // 101 'b-%' rows, not 2: FETCH_BATCH_SIZE is 100 (src/adapters/pg.ts),
        // and a batch that fails loses every row in it, not just the
        // offending one — the poison row needs to be alone in a *second*
        // batch so the first `.next()` on B genuinely succeeds and creates
        // its savepoint before A's, rather than the whole first batch
        // (b-0 included) failing before either savepoint exists.
        await db(lossTable).insert([
          { label: 'a-0', value: 1 },
          ...Array.from({ length: 100 }, (_, i) => ({ label: `b-${i}`, value: 1 })),
          { label: 'b-100', value: 0 },
        ])

        let caught: unknown
        await db
          .transaction(async (trx) => {
            const handle = await (
              trx.client as unknown as { acquireConnection: () => Promise<unknown> }
            ).acquireConnection()

            // Real, uncontested work with nothing to do with either stream
            // — this is what must not silently vanish.
            await trx(lossTable).insert({ label: 'proof-of-work', value: 1 })

            const iterB = adapter.stream!(
              handle,
              `select label, 1 / value as ratio from ${lossTable} where label like $1 order by id`,
              ['b-%']
            )[Symbol.asyncIterator]()
            await iterB.next() // b-0: B's savepoint, created first, succeeds

            const iterA = adapter.stream!(
              handle,
              `select id from ${lossTable} where label like $1 order by id`,
              ['a-%']
            )[Symbol.asyncIterator]()
            await iterA.next() // a-0: A's savepoint, created second, succeeds

            for (let i = 1; i < 100; i++) await iterB.next() // rest of batch 1
            await expect(iterB.next()).rejects.toThrow() // b-100: divides by zero
            await expect(iterA.next()).rejects.toThrow() // cursor cascaded away
          })
          .catch((err) => {
            caught = err
          })

        expect(caught).toBeInstanceOf(CfKnexError)
        expect((caught as CfKnexError).code).toBe('COMMIT_SILENTLY_ROLLED_BACK')

        const proof = await db(lossTable).where('label', 'proof-of-work').first()
        expect(proof).toBeFalsy()
      } finally {
        await db.schema.dropTableIfExists(lossTable)
      }
    })

    // The shape that actually matters to real users, and the only one this
    // check's dominant reachable path has anything to do with: no
    // streaming, no savepoints — just a statement error caught inside a
    // db.transaction() callback instead of left to propagate.
    test('db.transaction() rejects instead of silently committing nothing when a plain, non-streaming statement error is swallowed', async () => {
      const plainTable = `cf_knex_stream_commit_loss_plain_${Math.random().toString(36).slice(2, 10)}`
      try {
        await db.schema.createTable(plainTable, (t) => {
          t.increments('id')
          t.string('label')
        })

        let caught: unknown
        await db
          .transaction(async (trx) => {
            await trx(plainTable).insert({ label: 'proof-of-work' })
            await trx.raw('select 1 / 0').catch(() => {})
          })
          .catch((err) => {
            caught = err
          })

        expect(caught).toBeInstanceOf(CfKnexError)
        expect((caught as CfKnexError).code).toBe('COMMIT_SILENTLY_ROLLED_BACK')
        expect(await db(plainTable).where('label', 'proof-of-work').first()).toBeFalsy()
      } finally {
        await db.schema.dropTableIfExists(plainTable)
      }
    })
  })
} else {
  skip('pg premature-release and savepoint-sharing regressions', 'POSTGRES_URL')
}
