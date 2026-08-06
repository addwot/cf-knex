import { expect, test, vi } from 'vitest'
import { CfKnexError } from '../../src/core/errors'
import { createLibsqlAdapter } from '../../src/adapters/libsql'
import type { Client, Transaction } from '@libsql/client'

test('declares dialect sqlite, driver libsql, no streaming, and real transactions', () => {
  const adapter = createLibsqlAdapter({ url: 'http://127.0.0.1:8080' })
  expect(adapter.dialect).toBe('sqlite')
  expect(adapter.driver).toBe('libsql')
  expect(adapter.capabilities.streaming).toBe(false)
  // execute() no longer sends BEGIN/COMMIT/ROLLBACK through the isolated
  // per-call path that made this false -- see src/adapters/libsql.ts's
  // "Transactions" doc comment for the live-verified evidence and its
  // execute()'s own comment for what routes each statement where instead.
  expect(adapter.capabilities.transactions).toBe(true)
})

test('has no hints.transactions override -- the capability itself is supported now', () => {
  const adapter = createLibsqlAdapter({ url: 'http://127.0.0.1:8080' })
  expect(adapter.hints?.transactions).toBeUndefined()
})

test('omits validate() entirely -- neither the http nor the ws Client exposes genuine staleness on this handle (regression)', () => {
  // An earlier draft of this adapter implemented validate() as
  // `!client.closed`, on the assumption that Client.closed flips true when
  // a handle goes stale while idle in the pool. Verified false for both
  // schemes this adapter can reach -- see src/adapters/libsql.ts's "No
  // validate()" comment (next to execute()) for the live evidence: closed
  // stayed false after a failing statement, after total network failure,
  // and even after a real socket was destroyed out from under an
  // established ws: connection (which instead reconnected transparently).
  // A validate() built on that flag would never return false for a truly
  // dead handle -- the opposite of what validate() exists for.
  const adapter = createLibsqlAdapter({ url: 'http://127.0.0.1:8080' })
  expect(adapter.validate).toBeUndefined()
})

test('passes a >2^53 lastInsertRowid through as bigint, not Number() (regression)', async () => {
  // 9007199254740995n is 2^53 + 3 -- Number(9007199254740995n) rounds to
  // 9007199254740996, a different (and wrong) id. RawResult.insertId is
  // typed number | bigint precisely so this survives; an earlier draft of
  // this adapter called Number(res.lastInsertRowid) instead, which this
  // test would have caught.
  const execute = vi.fn().mockResolvedValue({
    rows: [],
    columns: [],
    rowsAffected: 1,
    lastInsertRowid: 9007199254740995n,
  })
  const adapter = createLibsqlAdapter({ url: 'http://127.0.0.1:8080' })
  const raw = await adapter.execute({ execute }, 'insert into t (name) values (?)', ['x'])

  expect(raw.insertId).toBe(9007199254740995n)
  expect(typeof raw.insertId).toBe('bigint')
})

test('a SELECT (undefined lastInsertRowid) maps to insertId undefined, not 0n', async () => {
  const execute = vi.fn().mockResolvedValue({
    rows: [{ id: 1, name: 'x' }],
    columns: ['id', 'name'],
    rowsAffected: 0,
    lastInsertRowid: undefined,
  })
  const adapter = createLibsqlAdapter({ url: 'http://127.0.0.1:8080' })
  const raw = await adapter.execute({ execute }, 'select * from t', [])

  expect(raw.insertId).toBeUndefined()
  expect(raw.rows).toEqual([{ id: 1, name: 'x' }])
  expect(raw.affectedRows).toBe(0)
})

test('passes columns through unchanged as fields, even when not an array, not coerced to undefined', async () => {
  // A well-formed ResultSet.columns is always an array; this simulates a
  // future version or test double that hands back something else, to prove
  // toRawResult no longer does `Array.isArray(columns) ? columns : undefined`
  // -- that coercion would turn this same input into undefined and pass
  // silently, the exact behavior this test is named for and needs to fail on.
  const execute = vi.fn().mockResolvedValue({
    rows: [],
    columns: 'nope',
    rowsAffected: 0,
    lastInsertRowid: undefined,
  })
  const adapter = createLibsqlAdapter({ url: 'http://127.0.0.1:8080' })
  const raw = await adapter.execute({ execute }, 'select * from t', [])

  expect(raw.fields).toBe('nope')
})

test('throws CfKnexError.malformedResult when execute() does not resolve to an object with a rows field', async () => {
  const execute = vi.fn().mockResolvedValue([{ id: 1 }])
  const adapter = createLibsqlAdapter({ url: 'http://127.0.0.1:8080' })

  await expect(adapter.execute({ execute }, 'select 1', [])).rejects.toThrow(CfKnexError)
  await expect(adapter.execute({ execute }, 'select 1', [])).rejects.toMatchObject({
    code: 'MALFORMED_DRIVER_RESULT',
  })
})

test('throws CfKnexError.malformedResult when execute() resolves to null', async () => {
  const execute = vi.fn().mockResolvedValue(null)
  const adapter = createLibsqlAdapter({ url: 'http://127.0.0.1:8080' })

  await expect(adapter.execute({ execute }, 'select 1', [])).rejects.toMatchObject({
    code: 'MALFORMED_DRIVER_RESULT',
  })
})

test('throws CfKnexError.malformedResult when rows is present but not an array', async () => {
  const execute = vi.fn().mockResolvedValue({ rows: 'not-an-array', rowsAffected: 0, lastInsertRowid: undefined })
  const adapter = createLibsqlAdapter({ url: 'http://127.0.0.1:8080' })

  await expect(adapter.execute({ execute }, 'select 1', [])).rejects.toMatchObject({
    code: 'MALFORMED_DRIVER_RESULT',
  })
})

test('throws CfKnexError.malformedResult when rowsAffected is not a number', async () => {
  const execute = vi.fn().mockResolvedValue({ rows: [], rowsAffected: '3', lastInsertRowid: undefined })
  const adapter = createLibsqlAdapter({ url: 'http://127.0.0.1:8080' })

  await expect(adapter.execute({ execute }, 'update t set x = 1', [])).rejects.toMatchObject({
    code: 'MALFORMED_DRIVER_RESULT',
  })
})

test('throws CfKnexError.malformedResult when lastInsertRowid is neither bigint nor undefined', async () => {
  // A well-formed ResultSet never hands this adapter a plain number here --
  // @libsql/core's own ResultSetImpl always carries lastInsertRowid as
  // bigint | undefined. This simulates a future version, or a test double,
  // that returns the "wrong" JS representation instead -- the boundary
  // src/adapters/libsql.ts's toRawResult doc comment says is still worth
  // guarding even though the package's own construction path is trusted.
  const execute = vi.fn().mockResolvedValue({ rows: [], rowsAffected: 1, lastInsertRowid: 42 })
  const adapter = createLibsqlAdapter({ url: 'http://127.0.0.1:8080' })

  await expect(adapter.execute({ execute }, 'insert into t values (1)', [])).rejects.toMatchObject({
    code: 'MALFORMED_DRIVER_RESULT',
  })
})

test('release() closes the handle and resolves without throwing', async () => {
  const close = vi.fn()
  const adapter = createLibsqlAdapter({ url: 'http://127.0.0.1:8080' })
  await expect(adapter.release({ close })).resolves.toBeUndefined()
  expect(close).toHaveBeenCalledTimes(1)
})

test('destroy() closes each acquired-but-not-released handle exactly once, even when called twice', async () => {
  // A fresh adapter's `open` set is empty, so calling destroy() twice on one
  // proves nothing about the loop or the `open.clear()` that makes the
  // second call safe -- it never runs either time. Acquire a real handle
  // first so the loop body executes, and spy on its close() to pin that the
  // second destroy() call doesn't close it again.
  const adapter = createLibsqlAdapter({ url: 'http://127.0.0.1:8080' })
  const handle = (await adapter.acquire()) as Client
  const spy = vi.spyOn(handle, 'close')

  await adapter.destroy()
  await adapter.destroy()

  expect(spy).toHaveBeenCalledTimes(1)
})

test('destroy() does not re-close a handle that release() already closed', async () => {
  // Pins the other half of the same open-set bookkeeping: release() must
  // remove the handle from `open` (not just close it), so a later destroy()
  // sweep doesn't close it a second time.
  const adapter = createLibsqlAdapter({ url: 'http://127.0.0.1:8080' })
  const handle = (await adapter.acquire()) as Client
  const spy = vi.spyOn(handle, 'close')

  await adapter.release(handle)
  await adapter.destroy()

  expect(spy).toHaveBeenCalledTimes(1)
})

test('release() rolls back a transaction still open on the handle before closing it', async () => {
  // A live integration test proves this doesn't corrupt data (the row never
  // becomes durable either way), but @libsql/client's HttpClient.close()
  // turns out to also tear down a pending transaction as a side effect of
  // closing its underlying stream (confirmed live: a transaction abandoned
  // by only closing the client, with rollback() never called at all, still
  // doesn't block a later writer) -- so that black-box check alone can't
  // tell whether release() actually calls rollback(), only whether closing
  // happened at all. This pins the call directly instead.
  const rollback = vi.fn().mockResolvedValue(undefined)
  const tx = { execute: vi.fn(), commit: vi.fn(), rollback, close: vi.fn() } as unknown as Transaction
  const transaction = vi.fn().mockResolvedValue(tx)
  const close = vi.fn()
  const handle = { transaction, close } as unknown as Client
  const adapter = createLibsqlAdapter({ url: 'http://127.0.0.1:8080' })

  await adapter.execute(handle, 'BEGIN', [])
  await adapter.release(handle)

  expect(rollback).toHaveBeenCalledTimes(1)
  expect(close).toHaveBeenCalledTimes(1)
})

test('destroy() rolls back a transaction still open on an un-released handle before closing it', async () => {
  // Same reasoning as the release() test above -- pins the rollback() call
  // itself rather than a downstream effect that turns out to happen anyway
  // for an unrelated reason. Spies on the real acquire()'d handle's own
  // transaction() (as the other destroy() tests here spy on close()) rather
  // than faking the handle outright, since destroy() only reaches handles
  // that came from this adapter's own `open` set.
  const adapter = createLibsqlAdapter({ url: 'http://127.0.0.1:8080' })
  const handle = (await adapter.acquire()) as Client
  const rollback = vi.fn().mockResolvedValue(undefined)
  const tx = { execute: vi.fn(), commit: vi.fn(), rollback, close: vi.fn() } as unknown as Transaction
  vi.spyOn(handle, 'transaction').mockResolvedValue(tx)

  await adapter.execute(handle, 'BEGIN', [])
  await adapter.destroy()

  expect(rollback).toHaveBeenCalledTimes(1)
})

test('acquire() loads @libsql/client and returns a usable handle inside workerd, with no network I/O', async () => {
  // The only test in this file that exercises the real dynamic
  // import('@libsql/client') inside vitest-pool-workers rather than handing
  // execute() a hand-made fake -- proof the package (and this adapter's
  // dynamic import of it) actually loads inside workerd at all. The fetch
  // stub below asserts the "no network I/O" claim directly rather than just
  // stating it: src/adapters/libsql.ts's acquire() comment establishes that
  // createClient() for an http: URL never calls fetch (protocolVersion
  // defaults to 2, which resolves its endpoint synchronously), and this
  // pins that so a future change that makes createClient() start probing
  // would fail this test, not just go unnoticed.
  const fetchSpy = vi.fn()
  const originalFetch = globalThis.fetch
  globalThis.fetch = fetchSpy as unknown as typeof fetch
  try {
    const adapter = createLibsqlAdapter({ url: 'http://127.0.0.1:8080' })
    const handle = await adapter.acquire()
    expect(typeof (handle as { execute?: unknown }).execute).toBe('function')
    expect((handle as { protocol?: unknown }).protocol).toBe('http')
    expect((handle as { closed?: unknown }).closed).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()

    await adapter.destroy()
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('acquire() returns a fresh handle on every call, never a shared one (regression)', async () => {
  // Regression coverage: an earlier draft of this adapter cached and shared
  // one Client across every acquire() call, with release() a no-op. That
  // shape is unsafe here for a structural reason (see src/adapters/
  // libsql.ts's doc comment): the first release() tarn calls on any handle
  // would close the one Client every other still-pooled handle secretly
  // is, killing all of them at once, not just the one being evicted.
  const adapter = createLibsqlAdapter({ url: 'http://127.0.0.1:8080' })
  const first = await adapter.acquire()
  const second = await adapter.acquire()
  expect(second).not.toBe(first)
  await adapter.destroy()
})

// `SET TRANSACTION READ ONLY` is remembered on the handle so the `BEGIN`
// knex emits immediately after it opens a 'read' transaction rather than the
// default 'write'. These pin the other half: that memory must not outlive
// the one statement it was meant for. tarn reuses a handle across unrelated
// callers, and a stale 'read' turns a later, ordinary `db.transaction()`
// into a read-only one whose writes fail for no reason the caller can see.
// (src/adapters/tidb-http.ts carries the same pair for its own remembered
// isolation level -- same defect, same shape.)
function makeReadOnlyProbe() {
  const tx = { execute: vi.fn(), commit: vi.fn(), rollback: vi.fn(), close: vi.fn() } as unknown as Transaction
  const transaction = vi.fn().mockResolvedValue(tx)
  const execute = vi.fn().mockResolvedValue({ rows: [], rowsAffected: 0, columns: [] })
  const handle = { transaction, execute, close: vi.fn() } as unknown as Client
  return { handle, transaction }
}

test('a remembered read-only mode does not leak into a later unrelated transaction', async () => {
  const { handle, transaction } = makeReadOnlyProbe()
  const adapter = createLibsqlAdapter({ url: 'http://127.0.0.1:8080' })

  await adapter.execute(handle, 'SET TRANSACTION READ ONLY;', [])
  await adapter.execute(handle, 'select 1', [])
  await adapter.execute(handle, 'BEGIN;', [])

  expect(transaction).toHaveBeenCalledWith('write')
})

test('a remembered read-only mode does not survive a BEGIN that failed', async () => {
  const { handle, transaction } = makeReadOnlyProbe()
  transaction.mockRejectedValueOnce(new Error('network'))
  const adapter = createLibsqlAdapter({ url: 'http://127.0.0.1:8080' })

  await adapter.execute(handle, 'SET TRANSACTION READ ONLY;', [])
  await expect(adapter.execute(handle, 'BEGIN;', [])).rejects.toThrow('network')
  await adapter.execute(handle, 'BEGIN;', [])

  expect(transaction).toHaveBeenLastCalledWith('write')
})

test('the read-only mode still reaches the BEGIN that immediately follows it', async () => {
  // The complement of the two above: dropping the memory too eagerly would
  // pass both of them and silently break `db.transaction(fn, { readOnly:
  // true })`, which is the entire reason the memory exists.
  const { handle, transaction } = makeReadOnlyProbe()
  const adapter = createLibsqlAdapter({ url: 'http://127.0.0.1:8080' })

  await adapter.execute(handle, 'SET TRANSACTION READ ONLY;', [])
  await adapter.execute(handle, 'BEGIN;', [])

  expect(transaction).toHaveBeenCalledWith('read')
})
