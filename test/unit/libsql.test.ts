import { expect, test, vi } from 'vitest'
import { CfKnexError } from '../../src/core/errors'
import { createLibsqlAdapter } from '../../src/adapters/libsql'
import type { Client } from '@libsql/client'

test('declares dialect sqlite, driver libsql, and no streaming/transactions', () => {
  const adapter = createLibsqlAdapter({ url: 'http://127.0.0.1:8080' })
  expect(adapter.dialect).toBe('sqlite')
  expect(adapter.driver).toBe('libsql')
  expect(adapter.capabilities.streaming).toBe(false)
  // See src/adapters/libsql.ts's own doc comment for the live-verified
  // evidence: routing BEGIN/COMMIT/ROLLBACK through this adapter's plain
  // execute() reproduced the worst failure this project's contract has --
  // a "rolled back" row still present afterward -- when checked directly
  // against the docker container with capabilities.transactions forced to
  // true.
  expect(adapter.capabilities.transactions).toBe(false)
})

test('hints.transactions names this package\'s real atomic primitives, not just the generic default', () => {
  const adapter = createLibsqlAdapter({ url: 'http://127.0.0.1:8080' })
  expect(adapter.hints?.transactions).toMatch(/Client\.batch\(\)/)
  expect(adapter.hints?.transactions).toMatch(/Client\.transaction\(\)/)
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
