import { expect, test, vi } from 'vitest'
import { createTidbHttpAdapter } from '../../src/adapters/tidb-http'

// A TiDB transaction is one server-side session, and a session runs one
// statement at a time — the driver's own README says so ("The transaction is
// not concurrent-safe. You are not allowed to run SQLs parallel in the same
// transaction"), and tidbcloud/serverless-js#61 is the bug report that got it
// written down. The maintainers closed that issue as won't-fix: "the
// serverless driver will do nothing about it… run the transaction serially".
//
// knex will not do it for us. It chains *sibling* transactions through
// `_lastChild` (knex/lib/execution/transaction.js) but nothing stops a caller
// awaiting several builders on one open transaction at once:
//
//   await Promise.all([trx('a').insert(…), trx('b').insert(…)])
//
// Both reach this adapter's `execute()` before either resolves. These tests
// pin that the adapter is what serialises them.

// A `Tx` mock that records how many `execute()` calls are inside it at the
// same moment. Each call yields to the microtask queue before returning, so a
// second call entering while the first is suspended is observed as an overlap
// rather than missed. Deterministic: no timers, no wall-clock.
function makeOverlapTrackingHandle() {
  let inFlight = 0
  let maxInFlight = 0
  const order: string[] = []

  const txExecute = vi.fn(async (sql: string) => {
    order.push(sql)
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    await Promise.resolve()
    await Promise.resolve()
    inFlight -= 1
    return { rows: [], rowsAffected: null, lastInsertId: null }
  })

  const tx = { execute: txExecute, rollback: vi.fn(async () => ({ rows: [] })) }
  const execute = vi.fn(async (sql: string) => {
    order.push(sql)
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    await Promise.resolve()
    await Promise.resolve()
    inFlight -= 1
    return { rows: [], rowsAffected: null, lastInsertId: null }
  })

  return {
    handle: { execute, begin: vi.fn(async () => tx) },
    txExecute,
    execute,
    order,
    maxInFlight: () => maxInFlight,
  }
}

test('statements issued in parallel on one transaction never overlap on the session', async () => {
  const { handle, maxInFlight } = makeOverlapTrackingHandle()
  await adapterExecute(handle, 'BEGIN;')

  await Promise.all([
    adapterExecute(handle, 'insert into t values (1)'),
    adapterExecute(handle, 'insert into t values (2)'),
    adapterExecute(handle, 'insert into t values (3)'),
  ])

  expect(maxInFlight()).toBe(1)
})

test('parallel statements reach the session in the order they were issued', async () => {
  const { handle, order } = makeOverlapTrackingHandle()
  await adapterExecute(handle, 'BEGIN;')

  // Ordering is established when `execute()` is entered, not when its turn
  // comes up, so a caller reading the resulting rows can reason about which
  // statement saw which. Anything else would make a serialised transaction
  // non-deterministic in a way the parallel version at least was honest about.
  await Promise.all([
    adapterExecute(handle, 'insert into t values (1)'),
    adapterExecute(handle, 'insert into t values (2)'),
    adapterExecute(handle, 'insert into t values (3)'),
  ])

  expect(order).toEqual([
    'insert into t values (1)',
    'insert into t values (2)',
    'insert into t values (3)',
  ])
})

test('a statement that throws does not wedge the ones queued behind it', async () => {
  const { handle, txExecute } = makeOverlapTrackingHandle()
  await adapterExecute(handle, 'BEGIN;')
  txExecute.mockImplementationOnce(async () => {
    throw new Error('duplicate key')
  })

  const failed = adapterExecute(handle, 'insert into t values (1)')
  const queued = adapterExecute(handle, 'insert into t values (2)')

  await expect(failed).rejects.toThrow('duplicate key')
  // The whole point of a transaction failing is what the caller does next —
  // usually a ROLLBACK on this same handle. A queue that only advanced on
  // success would deadlock exactly there.
  await expect(queued).resolves.toBeTruthy()
})

test('a ROLLBACK queued behind a failing statement still ends the transaction', async () => {
  const { handle, txExecute, execute } = makeOverlapTrackingHandle()
  await adapterExecute(handle, 'BEGIN;')
  txExecute.mockImplementationOnce(async () => {
    throw new Error('deadlock')
  })

  const failed = adapterExecute(handle, 'update t set a = 1')
  const rollback = adapterExecute(handle, 'ROLLBACK')
  await expect(failed).rejects.toThrow('deadlock')
  await expect(rollback).resolves.toBeTruthy()

  // Ended: the next statement goes to the base connection, not the dead `Tx`.
  await adapterExecute(handle, 'select 1')
  expect(execute).toHaveBeenCalledWith('select 1', [], { fullResult: true })
})

test('statements outside a transaction stay parallel', async () => {
  // Each is an independent HTTP request against a fresh server-side session,
  // so there is no session to corrupt — and serialising them would throttle
  // the common case to fix a problem it does not have. Concurrency here is
  // bounded by the pool (`pool.max`), not by this adapter.
  const { handle, maxInFlight } = makeOverlapTrackingHandle()

  await Promise.all([
    adapterExecute(handle, 'select 1'),
    adapterExecute(handle, 'select 2'),
    adapterExecute(handle, 'select 3'),
  ])

  expect(maxInFlight()).toBe(3)
})

test('serialisation is per handle, so one transaction does not block another', async () => {
  // Two handles means two sessions and two transactions. `txStates` is keyed
  // by handle, so the queue must be too — a shared one would turn a client's
  // whole pool into a single-threaded queue.
  const a = makeOverlapTrackingHandle()
  const b = makeOverlapTrackingHandle()
  await adapterExecute(a.handle, 'BEGIN;')
  await adapterExecute(b.handle, 'BEGIN;')

  await Promise.all([
    adapterExecute(a.handle, 'insert into t values (1)'),
    adapterExecute(b.handle, 'insert into t values (2)'),
  ])

  expect(a.maxInFlight()).toBe(1)
  expect(b.maxInFlight()).toBe(1)
  expect(a.txExecute).toHaveBeenCalledTimes(1)
  expect(b.txExecute).toHaveBeenCalledTimes(1)
})

test('the session check sees the token its own statement returned, not a sibling\'s', async () => {
  // `assertSameSession` reads `tx.conn.session` *after* the statement
  // resolves. Unserialised, a sibling's response can overwrite that field in
  // between, so the check would report on whichever statement finished last —
  // able to both miss a real escape and invent one. Serialising is what makes
  // the detector sound, not merely what makes the session safe.
  const txConn = { session: 'session-1' }
  const txExecute = vi.fn(async (sql: string) => {
    await Promise.resolve()
    // Only the second statement genuinely escapes.
    if (sql.includes('(2)')) txConn.session = 'session-2'
    return { rows: [], rowsAffected: null, lastInsertId: null }
  })
  const tx = { execute: txExecute, rollback: vi.fn(async () => ({ rows: [] })), conn: txConn }
  const handle = { execute: vi.fn(), begin: vi.fn(async () => tx) }

  await adapterExecute(handle, 'BEGIN;')
  const first = adapterExecute(handle, 'insert into t values (1)')
  const second = adapterExecute(handle, 'insert into t values (2)')

  await expect(first).resolves.toBeTruthy()
  await expect(second).rejects.toMatchObject({ code: 'TRANSACTION_ESCAPED' })
})

const adapter = createTidbHttpAdapter({ url: 'mysql://u:p@x.tidbcloud.com:4000/db' })

function adapterExecute(handle: unknown, sql: string) {
  return adapter.execute(handle, sql, [])
}
