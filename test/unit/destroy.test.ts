import { expect, test } from 'vitest'
import { createKnexClient } from '../../src/core/client'
import { createFakeAdapter } from '../support/fake-adapter'

// Every test here runs against a fake adapter, so no timing depends on a real
// database: the hang these cover is tarn's own, and it reproduces with no I/O
// at all. `destroyTimeoutMs` is set to a few milliseconds rather than relying
// on the 6000 ms default, which keeps the suite fast *and* pins the option.
const budget = { destroyTimeoutMs: 50 }

// Collects `log.warn` instead of spying on the console: `createKnexClient`
// merges a caller `log` over its own defaults (src/core/client.ts), so this is
// the supported seam and it also proves a caller's logger is the one used.
function withWarnings() {
  const warnings: string[] = []
  return { warnings, knexOptions: { ...budget, log: { warn: (m: string) => warnings.push(m) } } }
}

/**
 * How many connections tarn still has checked out. This is the invariant the
 * transaction shapes below actually differ on, and the only one that survives
 * `destroy()` becoming bounded.
 */
function numUsed(db: { client: unknown }): number {
  return (db.client as { pool: { numUsed(): number } }).pool.numUsed()
}

/** Resolves `false` if `destroy()` is still pending well past its own budget. */
async function destroyCompletes(db: { destroy(): Promise<void> }): Promise<boolean> {
  return Promise.race([
    db.destroy().then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 2000)),
  ])
}

test('destroy() settles instead of hanging when a transactor was never finished', async () => {
  const { warnings, knexOptions } = withWarnings()
  const { adapter } = createFakeAdapter({ dialect: 'mysql' })
  const db = createKnexClient(adapter, knexOptions)

  // The bare transactor form, abandoned. tarn parks the handle in its `used`
  // list and waits on that resource's deferred with no timeout of its own, so
  // before `destroy()` was bounded this wedged the whole client forever.
  const trx = await db.transaction()
  await trx('t').insert({ a: 1 })

  expect(await destroyCompletes(db)).toBe(true)
  expect(warnings.join(' ')).toMatch(/stopped waiting for the connection pool after 50ms/)
  // States what actually happened. Claiming a forced close here would send
  // someone hunting for a leak that is really a stranded server-side lock.
  expect(warnings.join(' ')).toMatch(/Nothing was force-closed/)
  expect(warnings.join(' ')).toMatch(/await using trx = await db\.transaction\(\)/)

  await trx.rollback()
})

test('destroy() on the ordinary path does not warn and tears the adapter down once', async () => {
  const { warnings, knexOptions } = withWarnings()
  const { adapter, destroyCount } = createFakeAdapter({ dialect: 'mysql' })
  const db = createKnexClient(adapter, knexOptions)
  await db('t').select('*')

  expect(await destroyCompletes(db)).toBe(true)
  expect(destroyCount()).toBe(1)
  expect(warnings).toEqual([])
})

test('destroy() is idempotent — a second call does not tear the adapter down again', async () => {
  const { adapter, destroyCount } = createFakeAdapter({ dialect: 'mysql' })
  const db = createKnexClient(adapter, budget)
  await db('t').select('*')

  await db.destroy()
  await db.destroy()
  await db.destroy()

  expect(destroyCount()).toBe(1)
})

test("destroy() is bounded by the adapter's own teardown too, not just the pool's", async () => {
  const { warnings, knexOptions } = withWarnings()
  const { adapter } = createFakeAdapter({ dialect: 'mysql', hangOnDestroy: true })
  const db = createKnexClient(adapter, knexOptions)
  await db('t').select('*')

  // The pool drains cleanly here; it is `adapter.destroy()` that never settles.
  // A budget wrapped only around the pool teardown would still hang.
  expect(await destroyCompletes(db)).toBe(true)
  // `\d+` rather than the literal budget: the adapter is given what the pool
  // left, so the figure in this message is the remainder and moves by a
  // millisecond or two between runs.
  expect(warnings.join(' ')).toMatch(/adapter's own teardown did not finish within the \d+ms left/)
})

test('destroyTimeoutMs is a total budget, not one per phase', async () => {
  const warnings: string[] = []
  // Larger than the shared 50ms budget so the two outcomes are separated by
  // more than scheduling noise: total spends ~200ms, per-phase would spend
  // ~400ms, and the assertion sits between them.
  const budgetMs = 200
  const { adapter } = createFakeAdapter({ dialect: 'mysql', hangOnDestroy: true })
  const db = createKnexClient(adapter, {
    destroyTimeoutMs: budgetMs,
    log: { warn: (m: string) => warnings.push(m) },
  })

  // Wedge *both* phases at once: an unfinished transactor holds the handle so
  // the pool drain never completes, and `hangOnDestroy` stalls the adapter
  // teardown queued behind it.
  const trx = await db.transaction()
  await trx('t').insert({ a: 1 })

  const startedAt = Date.now()
  await db.destroy()
  const elapsed = Date.now() - startedAt

  expect(elapsed).toBeLessThan(2 * budgetMs - 20)
  // Both phases really did run and really did time out — otherwise the elapsed
  // assertion above could pass merely because one of them was skipped.
  expect(warnings.join(' ')).toMatch(/stopped waiting for the connection pool/)
  expect(warnings.join(' ')).toMatch(/adapter's own teardown did not finish/)
})

test('destroy() still reports a pool teardown failure', async () => {
  const { adapter } = createFakeAdapter({ dialect: 'mysql' })
  const db = createKnexClient(adapter, budget)
  await db('t').select('*')
  const boom = new Error('pool exploded')
  ;(db.client as unknown as { pool: { destroy(): Promise<void> } }).pool.destroy = () => Promise.reject(boom)

  await expect(db.destroy()).rejects.toThrow('pool exploded')
})

test('await using tears the client down at scope exit', async () => {
  const { adapter, destroyCount } = createFakeAdapter({ dialect: 'mysql' })
  {
    await using db = createKnexClient(adapter, budget)
    await db('t').select('*')
    expect(destroyCount()).toBe(0)
  }
  expect(destroyCount()).toBe(1)
})

test('await using rolls a transactor back when the caller never finished it', async () => {
  const { warnings, knexOptions } = withWarnings()
  const { adapter, calls } = createFakeAdapter({ dialect: 'mysql' })
  const db = createKnexClient(adapter, knexOptions)

  {
    await using trx = await db.transaction()
    await trx('t').insert({ a: 1 })
    // No commit, no rollback: exactly the shape that used to strand a
    // transaction on TiDB and Turso and wedge `destroy()` on the way out.
  }

  expect(calls.map((c) => c.sql).join(' ')).toMatch(/ROLLBACK/)
  // The handle is back in the pool, not merely rolled back. Asserted on the
  // pool rather than on `destroy()` completing: now that `destroy()` is bounded
  // it completes either way, so completion alone can no longer tell the two
  // apart. `adapter.release()` is the wrong signal too — tarn calls that only
  // when it evicts a resource for good, never when one returns to `free`.
  expect(numUsed(db)).toBe(0)

  // And because nothing is checked out, teardown takes the fast path and has
  // nothing to warn about.
  await db.destroy()
  expect(warnings).toEqual([])
})

test('await using does not roll back a transactor that was committed', async () => {
  const { adapter, calls } = createFakeAdapter({ dialect: 'mysql' })
  const db = createKnexClient(adapter, budget)

  {
    await using trx = await db.transaction()
    await trx('t').insert({ a: 1 })
    await trx.commit()
  }

  const sql = calls.map((c) => c.sql).join(' ')
  expect(sql).toMatch(/COMMIT/)
  expect(sql).not.toMatch(/ROLLBACK/)
  await db.destroy()
})

test('the callback form is unchanged — it releases on both commit and throw', async () => {
  const committing = createFakeAdapter({ dialect: 'mysql' })
  const dbA = createKnexClient(committing.adapter, budget)
  await dbA.transaction(async (trx) => {
    await trx('t').insert({ a: 1 })
  })
  expect(committing.calls.map((c) => c.sql).join(' ')).toMatch(/COMMIT/)
  expect(numUsed(dbA)).toBe(0)
  await dbA.destroy()

  const throwing = createFakeAdapter({ dialect: 'mysql' })
  const dbB = createKnexClient(throwing.adapter, budget)
  await expect(
    dbB.transaction(async (trx) => {
      await trx('t').insert({ a: 1 })
      throw new Error('boom')
    }),
  ).rejects.toThrow('boom')
  expect(throwing.calls.map((c) => c.sql).join(' ')).toMatch(/ROLLBACK/)
  expect(numUsed(dbB)).toBe(0)
  await dbB.destroy()
})
