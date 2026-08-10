import { expect, test } from 'vitest'
import type { Knex } from 'knex'
import { createPgAdapter, resolveConfig } from '../../src/adapters/pg'
import { createKnexClient } from '../../src/core/client'
import { CfKnexError } from '../../src/core/errors'
import { runConformanceSuite } from '../support/conformance'

const caps = { streaming: true, transactions: true }

// Same reasoning as test/integration/mysql2.test.ts's `skip()`: every
// conformance block here is conditional on a connection URL, so with no
// database configured this file would register zero tests, and vitest fails
// a file with no suite outright ("No test suite found in file"). A named
// `test.skip` placeholder — not `console.warn`, which never reaches the
// default reporter `pnpm test` uses — keeps the file always a valid suite
// and states which env var was missing.
function skip(name: string, envVar: string) {
  test.skip(`${name} (${envVar} not set)`, () => {})
}

if (process.env.POSTGRES_URL) {
  const url = process.env.POSTGRES_URL
  runConformanceSuite('pg (direct)', () => createKnexClient(createPgAdapter({ url })), caps)
} else {
  skip('pg (direct)', 'POSTGRES_URL')
}

// A real `Hyperdrive` binding exists only inside workerd, and `pg` loads only
// in plain Node (@cloudflare/vitest-pool-workers cannot import it — see the
// project-split comment in vitest.config.ts), so the two never meet inside
// this test pool and there is no way to exercise the adapter's `hyperdrive`
// branch here against a real binding. The real binding, reached through
// `wrangler dev` against a live postgres, is covered by the live tier
// instead — that is the only place a real `Hyperdrive` object exists to test
// against.
//
// Instead, build a plain object shaped like a real binding by parsing
// POSTGRES_URL — with all six fields a real `Hyperdrive` binding carries
// (`host`, `port`, `user`, `password`, `database`, *and* `connectionString`),
// not just `connectionString` alone — and run the full conformance suite
// against that.
//
// This live suite does NOT, on its own, prove that src/adapters/pg.ts's
// `resolveConfig` destructures `connectionString` out of the binding rather
// than spreading it whole. pg's own `ConnectionParameters` constructor
// overwrites every discrete field with whatever `parse(connectionString)`
// returns, and because the five discrete fields below are derived from that
// same URL, the parsed values and the spread values are identical either
// way — the merge is a no-op regardless of which shape `resolveConfig`
// returns, so this suite passes under a reverted `{ ...opts.hyperdrive }`
// spread exactly as well as it does under the real destructure. (An earlier
// version of this comment claimed a one-field shim was needed to prove the
// destructure "actually holds" and that a spread would fail it — that was
// wrong, and nothing here or in a six-field object fixes it: the suite
// cannot distinguish the two shapes at all, live, regardless of field
// count.) What this suite is still good for: proving the adapter doesn't
// choke on a realistic six-field object and exercising everything
// downstream of a successful connection. The actual destructure-vs-spread
// regression check is the structural test below, which inspects
// `resolveConfig`'s return value directly instead of going through pg.
function hyperdriveFrom(url: string) {
  const u = new URL(url)
  return {
    host: u.hostname,
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ''),
    connectionString: url,
  }
}

// Runs unconditionally — no live database needed, since `resolveConfig` is a
// pure function that never imports `pg` itself (only `acquire()` does, and
// this test never calls it) — and asserts on `resolveConfig`'s return value
// directly, before any of it reaches pg's own `ConnectionParameters`. This is
// the check the comment above explains a live connection cannot perform:
// `{ ...opts.hyperdrive }` and `{ connectionString }` are trivially
// distinguishable here. Asserts the exact key set, not merely that
// `connectionString` is present, so this fails just as loudly if a future
// edit spreads the binding *and* keeps `connectionString` as it would if
// `connectionString` were dropped entirely.
test('pg adapter hyperdrive config reads only connectionString, never the five credential fields', () => {
  const hyperdrive = {
    host: 'h',
    port: 5432,
    user: 'u',
    password: 'p',
    database: 'd',
    connectionString: 'postgres://u:p@h:5432/d',
  }
  expect(Object.keys(resolveConfig({ hyperdrive }))).toEqual(['connectionString'])
})

// `COMMIT_SILENTLY_ROLLED_BACK` is raised by the pg adapter's `execute()`
// (src/adapters/pg.ts) when postgres reports a `COMMIT` back as a `ROLLBACK`.
// The conformance suite reaches that only through `db.transaction(cb)`, where
// knex hands the error to the transaction's own promise and the caller does
// see it. These cover the path that suite never took: the caller committing
// the transaction itself, where knex swallowed the rejection and
// `await trx.commit()` resolved as though the write had landed — silent loss
// of exactly the work this error code exists to report. Each asserts the row
// is really gone as well as that the error arrived, so none can pass by the
// guard degrading into a false positive that rejects a healthy commit; the
// third pins that healthy case directly.
if (process.env.POSTGRES_URL) {
  const url = process.env.POSTGRES_URL

  async function withAbortedTransaction(commit: (trx: Knex.Transaction) => Promise<void>) {
    const db = createKnexClient(createPgAdapter({ url }))
    const table = `cfk_commit_guard_${Math.floor(Math.random() * 1e9).toString(36)}`
    try {
      await db.schema.createTable(table, (t) => t.integer('id'))
      const trx = await db.transaction()
      await trx(table).insert({ id: 1 })
      // Aborts the transaction server-side, and swallowing it is the point:
      // an error allowed to propagate would roll back visibly instead.
      await trx.raw('select * from a_table_that_does_not_exist_cfk').catch(() => {})
      let raised: unknown
      try {
        await commit(trx)
      } catch (err) {
        raised = err
      }
      const rows = await db(table).select('*')
      await db.schema.dropTableIfExists(table)
      return { raised, rows }
    } finally {
      await db.destroy()
    }
  }

  test('pg: a COMMIT executed as a ROLLBACK reaches the caller of trx.commit()', async () => {
    const { raised, rows } = await withAbortedTransaction(async (trx) => {
      await trx.commit()
    })
    expect(raised).toBeInstanceOf(CfKnexError)
    expect((raised as CfKnexError).code).toBe('COMMIT_SILENTLY_ROLLED_BACK')
    expect(rows).toEqual([])
  })

  test('pg: the same holds for `await using trx` + commit(), which the guide recommends', async () => {
    const { raised, rows } = await withAbortedTransaction(async (trx) => {
      await using disposable = trx as Knex.Transaction & AsyncDisposable
      await disposable.commit()
    })
    expect(raised).toBeInstanceOf(CfKnexError)
    expect((raised as CfKnexError).code).toBe('COMMIT_SILENTLY_ROLLED_BACK')
    expect(rows).toEqual([])
  })

  // The escape hatch `COMMIT_SILENTLY_ROLLED_BACK`'s message and the guide both
  // now point callers at, pinned here so the advice cannot rot: a statement run
  // inside a nested transaction (a SAVEPOINT) may fail without aborting the
  // outer transaction, so the work around it still commits. This is the only
  // answer to "can the loss be prevented" — once postgres has aborted the
  // transaction it rejects everything with 25P02, retries included, so there is
  // nothing to recover after the fact.
  test('pg: a failure inside a nested transaction does not cost the outer transaction its work', async () => {
    const db = createKnexClient(createPgAdapter({ url }))
    const table = `cfk_savepoint_${Math.floor(Math.random() * 1e9).toString(36)}`
    try {
      await db.schema.createTable(table, (t) => t.integer('id'))
      const trx = await db.transaction()
      await trx(table).insert({ id: 1 })
      await expect(
        trx.transaction(async (sp) => {
          await sp.raw('select * from a_table_that_does_not_exist_cfk')
        }),
      ).rejects.toThrow()
      // Still usable, which is the whole point — an aborted transaction would
      // reject this with 25P02.
      await trx(table).insert({ id: 2 })
      await expect(trx.commit()).resolves.not.toThrow()
      expect(await db(table).select('*')).toEqual([{ id: 1 }, { id: 2 }])
      await db.schema.dropTableIfExists(table)
    } finally {
      await db.destroy()
    }
  })

  test('pg: a healthy explicit commit still persists its work', async () => {
    const db = createKnexClient(createPgAdapter({ url }))
    const table = `cfk_commit_ok_${Math.floor(Math.random() * 1e9).toString(36)}`
    try {
      await db.schema.createTable(table, (t) => t.integer('id'))
      const trx = await db.transaction()
      await trx(table).insert({ id: 1 })
      await expect(trx.commit()).resolves.not.toThrow()
      expect(await db(table).select('*')).toEqual([{ id: 1 }])
      await db.schema.dropTableIfExists(table)
    } finally {
      await db.destroy()
    }
  })
} else {
  skip('pg (explicit commit surfaces COMMIT_SILENTLY_ROLLED_BACK)', 'POSTGRES_URL')
}

if (process.env.POSTGRES_URL) {
  const hyperdrive = hyperdriveFrom(process.env.POSTGRES_URL)
  runConformanceSuite(
    'pg (via Hyperdrive-shaped config)',
    () => createKnexClient(createPgAdapter({ hyperdrive })),
    caps,
  )
} else {
  skip('pg (via Hyperdrive-shaped config)', 'POSTGRES_URL')
}
