import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { DisposableKnex } from '../../src/core/disposable'
import { CfKnexError } from '../../src/core/errors'
import type { AdapterCapabilities } from '../../src/core/types'
import { retryStalledRequest } from './stall'

// `singleWriter` describes the *database*, not the adapter, which is why it
// isn't part of `AdapterCapabilities`: SQLite-family engines (libsql, Turso,
// D1) permit one write transaction at a time across the whole database, so an
// open write transaction blocks every other connection's write until it ends.
// Set it for those backends. It changes only how the concurrent-write case
// below is expressed — never whether that case's integrity property is
// checked.
type ConformanceOptions = AdapterCapabilities & { singleWriter?: boolean }

// How long the concurrent-write case below waits for its "outside" insert
// before declaring the pool starved. A starved pool hangs *forever* rather
// than merely being slow, so this only has to outlast real latency, and
// erring long costs nothing: it stays well inside the 30s per-test budget in
// vitest.config.ts. Erring short does cost something — at the original 2s,
// a slow-but-working hosted backend would fail this case with a confident
// "pool can't supply a second connection" message that is simply untrue.
const STARVED_POOL_DEADLINE_MS = 10_000

// `DisposableKnex`, not `Knex`, so the `await using` cases below compile: the
// disposer and the transactor overload that carries it live on that type, and
// every backend's factory already returns one.
export function runConformanceSuite(name: string, factory: () => DisposableKnex, caps: ConformanceOptions) {
  describe(`conformance: ${name}`, () => {
    let db: DisposableKnex
    const table = `cf_knex_${Math.random().toString(36).slice(2, 10)}`

    // Setup and teardown go through `retryStalledRequest` because vitest's own
    // retry covers test bodies only: a stalled statement here fails the hook,
    // and a failed hook skips every test in the suite rather than retrying one.
    // Inert for backends that do not set `timeoutMs` — see test/support/stall.ts.
    beforeAll(async () => {
      db = factory()
      await retryStalledRequest(async (attempt) => {
        // A request aborted at its budget may still have been applied, so a
        // second attempt cannot assume the table is absent.
        if (attempt > 1) await db.schema.dropTableIfExists(table)
        await db.schema.createTable(table, (t) => {
          t.increments('id')
          t.string('name')
          t.integer('score').nullable()
        })
      })
    })

    afterAll(async () => {
      // Already idempotent, so it needs no per-attempt handling.
      await retryStalledRequest(() => db.schema.dropTableIfExists(table))
      await db.destroy()
    })

    test('insert returns an id', async () => {
      if (db.client.dialect === 'postgresql') {
        // knex's postgres `processResponse` (node_modules/knex/lib/dialects/
        // postgres/index.js, the method right after `_query`) branches on
        // `resp.command === 'SELECT'` first, then a truthy `returning`, then
        // `UPDATE`/`DELETE` -> `resp.rowCount`, and only then falls through
        // to `return resp` — the *whole* result object — for anything else,
        // including a plain INSERT with no `.returning()`. Postgres has no
        // `insertId`; knex's documented postgres behavior is that you ask
        // for the id with `.returning('id')`, which routes through the
        // `returning` branch instead and gets back an array of row objects.
        // mysql and sqlite need no such thing (and mysql's dialect *warns*
        // if you add `.returning()` to it — do not add one to the `else`
        // branch below to "unify" the two cases).
        //
        // Confirmed empirically against a live postgres before this branch
        // was written: `const [id] = await db(table).insert({...})` throws
        // `TypeError: ... is not iterable` here — `resp` (a pg `Result`) is
        // a plain object, not an array, so destructuring it as one throws
        // rather than silently returning `undefined`.
        const [row] = await db(table).insert({ name: 'alice', score: 1 }).returning('id')
        expect(Number((row as { id: number }).id)).toBeGreaterThan(0)
      } else {
        const [id] = await db(table).insert({ name: 'alice', score: 1 })
        expect(Number(id)).toBeGreaterThan(0)
      }
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

    // The positive side of `caps.streaming` is not checked here — it has its
    // own, much heavier battery in `runStreamingSuite` (./streaming.ts),
    // which needs 250 rows and a table of its own. This covers the side that
    // battery structurally cannot: what a caller who reaches for `.stream()`
    // on a backend that has none actually gets. That is the majority case
    // (d1, libsql, tidb-http all declare `streaming: false`), and until now
    // it was only ever proven against a fake adapter in
    // test/unit/client.test.ts, never end to end through a real one.
    const noStreamingTest = caps.streaming ? test.skip : test
    noStreamingTest('.stream() rejects with a documented CfKnexError instead of hanging or yielding nothing', async () => {
      await expect(async () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars -- iterated purely to prove the loop body is never reached
        for await (const _row of db(table).stream()) {
          throw new Error('unreachable: should have rejected before yielding any row')
        }
      }).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' })
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

      // The two cases above only exercise knex's callback form, which has
      // always released on every path. These cover `await using`, the shape the
      // guide recommends for the transactor form, on the path that matters:
      // a scope that exits having neither committed nor rolled back. Proven
      // against a fake adapter in test/unit/destroy.test.ts, but the ROLLBACK
      // the disposer triggers is issued by the real driver — over HTTP with a
      // session token on tidb-http, over Hrana on libsql, over their own
      // connections on mysql2 and pg — so whether the row genuinely fails to
      // land is a per-backend question that only this suite can answer.
      test('await using rolls an unfinished transactor back', async () => {
        {
          await using trx = await db.transaction()
          await trx(table).insert({ name: 'ivan', score: 9 })
        }
        expect(await db(table).where('name', 'ivan').first()).toBeFalsy()
      })

      // The inverse, and the one that would break real code if the disposer
      // were too eager: disposal must be a no-op once the caller has committed,
      // not a second statement on a finished transaction.
      test('await using leaves a committed transactor alone', async () => {
        {
          await using trx = await db.transaction()
          await trx(table).insert({ name: 'judy', score: 10 })
          await trx.commit()
        }
        expect(await db(table).where('name', 'judy').first()).toBeTruthy()
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
      //
      // Requires the factory's pool to allow at least 2 simultaneous
      // connections. A factory pinning `pool: { max: 1 }` cannot supply the
      // second connection the "outside" insert below needs while the
      // transaction still holds the only one — see the timeout branch
      // below for what happens then, and why it fails fast with an
      // explanation rather than hanging.
      // A single-writer database cannot run this case concurrently at all: the
      // open write transaction holds a database-wide write lock, so the
      // "outside" insert below cannot complete until the transaction ends, and
      // the starved-pool race would always trip. The serialized variant below
      // checks the same integrity property in the only order such a database
      // permits. Confirmed against both a local libsql-server container and a
      // live Turso database.
      const concurrentWriteTest = caps.singleWriter ? test.skip : test
      concurrentWriteTest('a concurrent write outside an open transaction is not swallowed by its rollback', async () => {
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

        // A starved pool (e.g. `max: 1`) cannot supply a connection for this
        // insert while the transaction above still holds the only one —
        // naively awaiting it would then hang forever: the insert waits on
        // a connection only the transaction can free, and the transaction
        // waits on `gate`, which only this insert (once it resolves) goes
        // on to release below. Race it against a short timeout instead, and
        // release the gate on *both* paths, so a starved pool fails this
        // one assertion with an explanation instead of hanging first this
        // test (vitest's default per-test timeout) and then `afterAll`'s
        // `db.destroy()` behind it (which would itself block forever on
        // `pool.destroy()` waiting for the transaction's connection to come
        // back) — 5+10 opaque seconds becoming the whole file reported as a
        // failed suite, with no indication why.
        // Not `.catch()`-guarded before the race: knex builders are
        // thenables whose `.then()`/`.catch()` each independently trigger a
        // fresh `runner.run()` (node_modules/knex/lib/builder-interface-
        // augmenter.js) — attaching a `.catch()` here would run this insert
        // *twice*. It doesn't need one anyway: `Promise.race` itself attaches
        // a handler to every input, including the one that loses, so a late
        // rejection from the losing side is already observed, not unhandled.
        const outsideInsert = db(table).insert({ name: 'ivan-outside', score: 10 })
        const starved = Symbol('pool starved')
        const raced = await Promise.race([
          outsideInsert,
          new Promise((resolve) => setTimeout(() => resolve(starved), STARVED_POOL_DEADLINE_MS)),
        ])
        releaseGate()

        if (raced === starved) {
          // Let the transaction's own rollback finish before failing, so
          // this test doesn't also leak a connection the pool believes is
          // still checked out into whatever runs after it.
          await trxPromise.catch(() => {})
          throw new Error(
            `timed out after ${STARVED_POOL_DEADLINE_MS}ms waiting for the concurrent insert to complete — most likely the factory's pool can't supply a second connection while the transaction above still holds the only one (needs pool: { max } >= 2; 'pool: { max: 1 }' starves it), though a fixed deadline could in principle also trip on an unrelated slow or lock-blocked insert`,
          )
        }

        await expect(trxPromise).rejects.toThrow('rollback')

        // Not `expect(...).toBeFalsy()`: this exact assertion has failed on CI
        // against TiDB Cloud Serverless — the rolled-back row survived — and
        // resisted 49 local reproduction attempts across parallel load and
        // injected latency up to 1.5s, so the next occurrence has to be
        // diagnosable from the CI log alone. `toBeFalsy` reports only
        // "expected { Object } to be falsy", which distinguishes none of the
        // candidate causes; the table's actual contents and ids do.
        const inside = await db(table).where('name', 'ivan-inside').first()
        if (inside) {
          const rows = await db(table).select('*').orderBy('id')
          throw new Error(
            `a row inserted inside a transaction survived that transaction's ROLLBACK. The transaction rejected as expected, so knex issued ROLLBACK and the driver reported it succeeded. Table contents now: ${JSON.stringify(rows)}`,
          )
        }
        // The assertion a shared connection fails: with one session for
        // both the transaction and this insert, the insert either lands
        // inside the still-open transaction (and vanishes with the
        // rollback) or blocks until the rollback releases a lock it should
        // never have needed to wait on. Either way this row is missing.
        expect(await db(table).where('name', 'ivan-outside').first()).toBeTruthy()
      })

      // The single-writer counterpart of the case above, checking the same
      // property — an unrelated write must not be swallowed by a transaction's
      // rollback — in the only order a database-wide write lock permits. It
      // deliberately does not assert *when* the outside write lands, because
      // on such a database that is fixed by the lock rather than by anything
      // this project controls; it asserts only that it lands and that the
      // rolled-back row does not.
      const serializedWriteTest = caps.singleWriter ? test : test.skip
      serializedWriteTest('a write issued while a transaction is open still lands, and is not swallowed by its rollback', async () => {
        let releaseGate: () => void = () => {}
        const gate = new Promise<void>((resolve) => {
          releaseGate = resolve
        })

        const trxPromise = db.transaction(async (trx) => {
          await trx(table).insert({ name: 'judy-inside', score: 9 })
          await gate
          throw new Error('rollback')
        })

        await new Promise((resolve) => setTimeout(resolve, 50))

        // `Promise.resolve()` rather than a bare `await` further down: knex
        // builders are lazy thenables that don't issue their query until
        // something calls `.then()`, so binding the builder to a variable
        // would leave it un-started and defeat the point of issuing it while
        // the transaction is still open. `Promise.resolve` calls `.then()`
        // exactly once — attaching a second handler would run the insert
        // twice (node_modules/knex/lib/builder-interface-augmenter.js).
        const outsideInsert = Promise.resolve(db(table).insert({ name: 'judy-outside', score: 10 }))
        releaseGate()

        await expect(trxPromise).rejects.toThrow('rollback')
        await outsideInsert

        expect(await db(table).where('name', 'judy-inside').first()).toBeFalsy()
        expect(await db(table).where('name', 'judy-outside').first()).toBeTruthy()
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
