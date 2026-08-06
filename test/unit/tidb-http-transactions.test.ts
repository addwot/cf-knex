import { expect, test, vi } from 'vitest'
import { createTidbHttpAdapter } from '../../src/adapters/tidb-http'

// A fake `Connection`-shaped handle: `begin()` always hands back the same
// `Tx` mock (this project's adapter never calls `begin()` twice on one
// handle without an intervening COMMIT/ROLLBACK, so one shared mock is
// enough to observe everything routed to it).
function makeFakeHandle() {
  const txExecute = vi.fn(async () => ({ rows: [], rowsAffected: null, lastInsertId: null }))
  const txRollback = vi.fn(async () => ({ rows: [] }))
  const tx = { execute: txExecute, rollback: txRollback }
  const begin = vi.fn(async () => tx)
  const execute = vi.fn(async () => ({ rows: [], rowsAffected: null, lastInsertId: null }))
  return { handle: { execute, begin }, execute, begin, txExecute, txRollback }
}

const adapter = createTidbHttpAdapter({ url: 'mysql://u:p@x.tidbcloud.com:4000/db' })

test('BEGIN opens a transaction via begin(), not a plain execute() call', async () => {
  const { handle, execute, begin } = makeFakeHandle()
  const result = await adapter.execute(handle, 'BEGIN;', [])
  expect(begin).toHaveBeenCalledTimes(1)
  expect(execute).not.toHaveBeenCalled()
  expect(result.rows).toEqual([])
})

test('START TRANSACTION is recognised as an alternate spelling of BEGIN', async () => {
  const { handle, begin } = makeFakeHandle()
  await adapter.execute(handle, 'START TRANSACTION', [])
  expect(begin).toHaveBeenCalledTimes(1)
})

test('once a transaction is open, an ordinary statement is forwarded to the Tx, not the base connection', async () => {
  const { handle, execute, txExecute } = makeFakeHandle()
  await adapter.execute(handle, 'BEGIN;', [])
  await adapter.execute(handle, 'insert into t values (1)', [])
  expect(txExecute).toHaveBeenCalledWith('insert into t values (1)', [], { fullResult: true })
  expect(execute).not.toHaveBeenCalled()
})

test('ROLLBACK TO SAVEPOINT x is forwarded to the Tx and does not end the transaction', async () => {
  const { handle, execute, txExecute } = makeFakeHandle()
  await adapter.execute(handle, 'BEGIN;', [])
  await adapter.execute(handle, 'ROLLBACK TO SAVEPOINT sp1', [])
  expect(txExecute).toHaveBeenCalledWith('ROLLBACK TO SAVEPOINT sp1', [], { fullResult: true })
  // Still open: the next statement reaches the Tx too, not a fresh
  // conn.execute() call (which would mean the transaction had ended).
  await adapter.execute(handle, 'select 1', [])
  expect(txExecute).toHaveBeenLastCalledWith('select 1', [], { fullResult: true })
  expect(execute).not.toHaveBeenCalled()
})

test('a bare ROLLBACK is forwarded to the Tx and ends the transaction', async () => {
  const { handle, begin, txExecute } = makeFakeHandle()
  await adapter.execute(handle, 'BEGIN;', [])
  await adapter.execute(handle, 'ROLLBACK', [])
  expect(txExecute).toHaveBeenCalledWith('ROLLBACK', [], { fullResult: true })
  // Ended: the next BEGIN opens a fresh transaction instead of being
  // forwarded to the now-stale Tx.
  await adapter.execute(handle, 'BEGIN;', [])
  expect(begin).toHaveBeenCalledTimes(2)
})

test('RELEASE SAVEPOINT x is forwarded to the Tx and does not end the transaction', async () => {
  const { handle, execute, txExecute } = makeFakeHandle()
  await adapter.execute(handle, 'BEGIN;', [])
  await adapter.execute(handle, 'RELEASE SAVEPOINT sp1;', [])
  await adapter.execute(handle, 'select 1', [])
  expect(txExecute).toHaveBeenLastCalledWith('select 1', [], { fullResult: true })
  expect(execute).not.toHaveBeenCalled()
})

test('COMMIT is forwarded to the Tx and ends the transaction', async () => {
  const { handle, execute, txExecute } = makeFakeHandle()
  await adapter.execute(handle, 'BEGIN;', [])
  await adapter.execute(handle, 'COMMIT;', [])
  expect(txExecute).toHaveBeenCalledWith('COMMIT;', [], { fullResult: true })
  await adapter.execute(handle, 'select 1', [])
  expect(execute).toHaveBeenCalledWith('select 1', [], { fullResult: true })
})

test('a SET TRANSACTION ISOLATION LEVEL is remembered and applied to the next begin()', async () => {
  const { handle, begin } = makeFakeHandle()
  const result = await adapter.execute(handle, 'SET TRANSACTION ISOLATION LEVEL read committed;', [])
  expect(result.rows).toEqual([])
  await adapter.execute(handle, 'BEGIN;', [])
  expect(begin).toHaveBeenCalledWith({ isolation: 'READ COMMITTED' })
})

test('an unsupported isolation level throws, naming the level and the two that work', async () => {
  const { handle, begin } = makeFakeHandle()
  await expect(adapter.execute(handle, 'SET TRANSACTION ISOLATION LEVEL serializable;', [])).rejects.toMatchObject({
    code: 'UNSUPPORTED_TRANSACTION_MODE',
  })
  await expect(adapter.execute(handle, 'SET TRANSACTION ISOLATION LEVEL serializable;', [])).rejects.toThrow(
    /serializable/i,
  )
  await expect(adapter.execute(handle, 'SET TRANSACTION ISOLATION LEVEL serializable;', [])).rejects.toThrow(
    /READ COMMITTED/i,
  )
  await expect(adapter.execute(handle, 'SET TRANSACTION ISOLATION LEVEL serializable;', [])).rejects.toThrow(
    /REPEATABLE READ/i,
  )
  expect(begin).not.toHaveBeenCalled()
})

test('SET TRANSACTION READ ONLY throws instead of being silently dropped', async () => {
  const { handle } = makeFakeHandle()
  await expect(adapter.execute(handle, 'SET TRANSACTION READ ONLY;', [])).rejects.toMatchObject({
    code: 'UNSUPPORTED_TRANSACTION_MODE',
  })
  // A message specific to the read-only branch, not the generic
  // unsupported-isolation-level one both share the same error code with —
  // dropping the dedicated READ ONLY check (and letting this fall through
  // to the isolation-level branch instead) would still throw the same code
  // with a different message, so this has to pin the wording, not just the
  // code.
  await expect(adapter.execute(handle, 'SET TRANSACTION READ ONLY;', [])).rejects.toThrow(/no equivalent/i)
})

test('release() rolls back and clears an abandoned open transaction', async () => {
  const { handle, execute, txRollback } = makeFakeHandle()
  await adapter.execute(handle, 'BEGIN;', [])
  await adapter.release(handle)
  expect(txRollback).toHaveBeenCalledTimes(1)
  // No longer treated as mid-transaction: a later statement on this handle
  // goes straight to the base connection again.
  await adapter.execute(handle, 'select 1', [])
  expect(execute).toHaveBeenCalledWith('select 1', [], { fullResult: true })
})

test('release() swallows a failing rollback instead of rejecting', async () => {
  const { handle, txRollback } = makeFakeHandle()
  txRollback.mockRejectedValueOnce(new Error('boom'))
  await adapter.execute(handle, 'BEGIN;', [])
  await expect(adapter.release(handle)).resolves.toBeUndefined()
})

test('release() on a handle with no open transaction is a no-op', async () => {
  const { handle, txRollback } = makeFakeHandle()
  await expect(adapter.release(handle)).resolves.toBeUndefined()
  expect(txRollback).not.toHaveBeenCalled()
})

// knex emits `SET TRANSACTION ...` immediately before `BEGIN` on the same
// connection, so a remembered isolation level is meant to survive exactly one
// statement. If the BEGIN never arrives -- it failed, or the transaction was
// abandoned before it was sent -- the level must not sit on the pooled handle
// waiting to be applied to some later, unrelated transaction that asked for
// no isolation level at all. That would be silently wrong rather than loud:
// the later transaction would run at an isolation level its caller never
// requested and has no way to observe.
test('a remembered isolation level does not leak into a later unrelated transaction', async () => {
  const { handle, begin } = makeFakeHandle()

  await adapter.execute(handle, 'SET TRANSACTION ISOLATION LEVEL read committed;', [])
  // The BEGIN that should have followed never arrives; the handle goes back
  // to the pool and is later reused for ordinary work.
  await adapter.execute(handle, 'select 1', [])

  await adapter.execute(handle, 'BEGIN;', [])
  expect(begin).toHaveBeenCalledWith(undefined)
})

test('a remembered isolation level does not survive a BEGIN that failed', async () => {
  const { handle, begin } = makeFakeHandle()
  begin.mockRejectedValueOnce(new Error('network'))

  await adapter.execute(handle, 'SET TRANSACTION ISOLATION LEVEL repeatable read;', [])
  await expect(adapter.execute(handle, 'BEGIN;', [])).rejects.toThrow('network')

  await adapter.execute(handle, 'BEGIN;', [])
  expect(begin).toHaveBeenLastCalledWith(undefined)
})

// The `Tx` the real driver hands back holds a `conn` whose `session` is the
// `TiDB-Session` header token identifying the server-side transaction. It is
// reassigned from every response, and a live probe against TiDB Cloud
// Serverless confirmed it stays byte-identical for a transaction's whole
// lifetime, terminating COMMIT/ROLLBACK included. So a change mid-transaction
// means the server declined the token and ran the statement in autocommit —
// outside the transaction, where ROLLBACK cannot reach it.
function makeSessionFakeHandle(session: string) {
  const txConn = { session }
  const txExecute = vi.fn(async () => ({ rows: [], rowsAffected: null, lastInsertId: null }))
  const tx = { execute: txExecute, rollback: vi.fn(async () => ({ rows: [] })), conn: txConn }
  const begin = vi.fn(async () => tx)
  const execute = vi.fn(async () => ({ rows: [], rowsAffected: null, lastInsertId: null }))
  return { handle: { execute, begin }, execute, txExecute, txConn }
}

test('a session token that holds steady through a transaction raises nothing', async () => {
  const { handle } = makeSessionFakeHandle('session-1')
  await adapter.execute(handle, 'BEGIN;', [])
  await adapter.execute(handle, 'insert into t values (1)', [])
  await expect(adapter.execute(handle, 'COMMIT;', [])).resolves.toBeTruthy()
})

test('a statement whose session changed under it is reported as escaping the transaction', async () => {
  const { handle, txExecute, txConn } = makeSessionFakeHandle('session-1')
  await adapter.execute(handle, 'BEGIN;', [])
  txExecute.mockImplementationOnce(async () => {
    txConn.session = 'session-2'
    return { rows: [], rowsAffected: null, lastInsertId: null }
  })

  await expect(adapter.execute(handle, 'insert into t values (1)', [])).rejects.toMatchObject({
    code: 'TRANSACTION_ESCAPED',
  })
})

test('a COMMIT whose session changed under it is reported rather than returned as success', async () => {
  const { handle, txExecute, txConn } = makeSessionFakeHandle('session-1')
  await adapter.execute(handle, 'BEGIN;', [])
  await adapter.execute(handle, 'insert into t values (1)', [])
  txExecute.mockImplementationOnce(async () => {
    txConn.session = 'session-2'
    return { rows: [], rowsAffected: null, lastInsertId: null }
  })

  await expect(adapter.execute(handle, 'COMMIT;', [])).rejects.toMatchObject({ code: 'TRANSACTION_ESCAPED' })
  // The transaction still ended on this handle: the escape is not recoverable,
  // and leaving the entry behind would route the caller's next statement into
  // a transaction it believes is closed.
  await adapter.execute(handle, 'select 1', [])
  expect(txExecute).toHaveBeenCalledTimes(2)
})

test('a detected escape ends the transaction on that handle rather than stranding it', async () => {
  const { handle, execute, txExecute, txConn } = makeSessionFakeHandle('session-1')
  await adapter.execute(handle, 'BEGIN;', [])
  txExecute.mockImplementationOnce(async () => {
    txConn.session = 'session-2'
    return { rows: [], rowsAffected: null, lastInsertId: null }
  })
  await expect(adapter.execute(handle, 'insert into t values (1)', [])).rejects.toMatchObject({
    code: 'TRANSACTION_ESCAPED',
  })

  // The transaction is gone server-side, so the handle must stop routing
  // through the dead `Tx`. Left set, the caller's own cleanup goes to a
  // transaction that no longer exists — and on a `pool: { max: 1 }` client,
  // where cleanup necessarily reuses this handle, that hangs instead of
  // surfacing the escape.
  await adapter.execute(handle, 'drop table t', [])
  expect(execute).toHaveBeenCalledWith('drop table t', [], { fullResult: true })
  expect(txExecute).toHaveBeenCalledTimes(1)
})

test('the escape report names the statement kind but never the statement itself', async () => {
  const { handle, txExecute, txConn } = makeSessionFakeHandle('session-1')
  await adapter.execute(handle, 'BEGIN;', [])
  txExecute.mockImplementationOnce(async () => {
    txConn.session = 'session-2'
    return { rows: [], rowsAffected: null, lastInsertId: null }
  })

  // Raw SQL can carry inlined literals that bindings would otherwise keep out
  // of reach, and error messages travel to logs.
  const escaped = adapter
    .execute(handle, "insert into accounts (token) values ('hunter2')", [])
    .catch((err: Error) => err.message)
  await expect(escaped).resolves.toContain('an INSERT statement')
  await expect(escaped).resolves.not.toContain('hunter2')
})

test('a driver that does not expose a session is not treated as an escape', async () => {
  // The published driver could stop surfacing `conn.session`, or surface it
  // only on some responses. Either way the check has nothing to compare and
  // must stay silent rather than fail every transaction.
  const { handle } = makeFakeHandle()
  await adapter.execute(handle, 'BEGIN;', [])
  await adapter.execute(handle, 'insert into t values (1)', [])
  await expect(adapter.execute(handle, 'COMMIT;', [])).resolves.toBeTruthy()
})
