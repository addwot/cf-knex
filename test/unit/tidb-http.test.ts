import { expect, test, vi } from 'vitest'
import { CfKnexError } from '../../src/core/errors'
import { createTidbHttpAdapter } from '../../src/adapters/tidb-http'

test('requests fullResult and maps write metadata', async () => {
  const execute = vi.fn().mockResolvedValue({ rows: [], rowsAffected: 3, lastInsertId: 42 })
  const adapter = createTidbHttpAdapter({ url: 'mysql://u:p@x.tidbcloud.com:4000/db' })
  const raw = await adapter.execute({ execute }, 'insert into t values (?)', [1])

  expect(execute).toHaveBeenCalledWith('insert into t values (?)', [1], { fullResult: true })
  expect(raw.insertId).toBe(42)
  expect(raw.affectedRows).toBe(3)
})

test('declares no streaming, no transactions, and dialect mysql', () => {
  const adapter = createTidbHttpAdapter({ url: 'mysql://u:p@x.tidbcloud.com:4000/db' })
  expect(adapter.dialect).toBe('mysql')
  expect(adapter.driver).toBe('tidb-http')
  expect(adapter.capabilities.streaming).toBe(false)
  // See src/adapters/tidb-http.ts's doc comment for the full evidence trail:
  // routing BEGIN/COMMIT/ROLLBACK through this adapter's `execute()` is
  // mechanically reachable (verified against a stub HTTP transport), but
  // `false` here because that has not been verified against a live TiDB
  // Cloud gateway, and an unverified `true` risks a `db.transaction()` that
  // silently commits a rollback -- the worst failure mode this contract has.
  expect(adapter.capabilities.transactions).toBe(false)
})

test('omits validate() entirely -- an HTTP-backed handle cannot go stale between queries', () => {
  const adapter = createTidbHttpAdapter({ url: 'mysql://u:p@x.tidbcloud.com:4000/db' })
  expect(adapter.validate).toBeUndefined()
})

test('normalises a string lastInsertId -- what the real driver actually returns -- to bigint without precision loss', async () => {
  // node_modules/@tidbcloud/serverless/dist/index.d.ts's `FullResult.lastInsertId`
  // is typed `string | null`, and dist/index.js's `execute()` reads it straight
  // off the raw HTTP JSON body (`resp?.sLastInsertID`) with no numeric parsing --
  // so a real response never hands this adapter a plain `number`. This id is
  // one past `Number.MAX_SAFE_INTEGER` (2^53); `Number(id)` would round it.
  const execute = vi.fn().mockResolvedValue({ rows: [], rowsAffected: 1, lastInsertId: '9007199254740993' })
  const adapter = createTidbHttpAdapter({ url: 'mysql://u:p@x.tidbcloud.com:4000/db' })
  const raw = await adapter.execute({ execute }, 'insert into t values (?)', [1])

  expect(raw.insertId).toBe(9007199254740993n)
  expect(typeof raw.insertId).toBe('bigint')
})

test('a null lastInsertId (non-insert statements) maps to undefined, not 0n', async () => {
  const execute = vi.fn().mockResolvedValue({ rows: [{ id: 1 }], rowsAffected: null, lastInsertId: null })
  const adapter = createTidbHttpAdapter({ url: 'mysql://u:p@x.tidbcloud.com:4000/db' })
  const raw = await adapter.execute({ execute }, 'select * from t', [])

  expect(raw.insertId).toBeUndefined()
  expect(raw.affectedRows).toBeUndefined()
  expect(raw.rows).toEqual([{ id: 1 }])
})

test('throws CfKnexError.malformedResult when execute() does not resolve to a fullResult-shaped object', async () => {
  // Simulates a caller/proxy that ignored `{ fullResult: true }` and handed
  // back the bare `Row[]` shape the package's own `execute()` returns in that
  // case instead -- exactly the kind of malformed/unexpected shape that's
  // genuinely reachable at an HTTP boundary.
  const execute = vi.fn().mockResolvedValue([{ id: 1 }])
  const adapter = createTidbHttpAdapter({ url: 'mysql://u:p@x.tidbcloud.com:4000/db' })

  await expect(adapter.execute({ execute }, 'select 1', [])).rejects.toThrow(CfKnexError)
  await expect(adapter.execute({ execute }, 'select 1', [])).rejects.toMatchObject({
    code: 'MALFORMED_DRIVER_RESULT',
  })
})

test('throws CfKnexError.malformedResult when rows is present but neither an array nor null', async () => {
  const execute = vi.fn().mockResolvedValue({ rows: 'not-an-array', rowsAffected: 0, lastInsertId: null })
  const adapter = createTidbHttpAdapter({ url: 'mysql://u:p@x.tidbcloud.com:4000/db' })

  await expect(adapter.execute({ execute }, 'select 1', [])).rejects.toMatchObject({
    code: 'MALFORMED_DRIVER_RESULT',
  })
})

test('throws CfKnexError.malformedResult when execute() resolves to null', async () => {
  const execute = vi.fn().mockResolvedValue(null)
  const adapter = createTidbHttpAdapter({ url: 'mysql://u:p@x.tidbcloud.com:4000/db' })

  await expect(adapter.execute({ execute }, 'select 1', [])).rejects.toMatchObject({
    code: 'MALFORMED_DRIVER_RESULT',
  })
})

test('acquire() loads @tidbcloud/serverless and returns a usable handle inside workerd', async () => {
  // This is the only test in the suite that exercises the real dynamic
  // `import('@tidbcloud/serverless')` inside vitest-pool-workers rather than
  // handing `execute()` a hand-made handle object -- it is the proof the
  // package (and its dynamic import) actually loads inside workerd at all,
  // which is this adapter's entire premise. `fetch` is stubbed rather than
  // hitting a real TiDB Cloud endpoint, matching how `acquire()` wires the
  // ambient global `fetch` through to `connect()`.
  const originalFetch = globalThis.fetch
  const fetchStub = vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: (name: string) => (name === 'TiDB-Session' ? 'sess-abc123' : null) },
    json: async () => ({ types: [], rows: [], rowsAffected: 1, sLastInsertID: '7' }),
    text: async () => '',
  }))
  globalThis.fetch = fetchStub as unknown as typeof fetch

  try {
    const adapter = createTidbHttpAdapter({ url: 'mysql://u:p@x.tidbcloud.com:4000/db' })
    const handle = await adapter.acquire()
    expect(typeof (handle as { execute?: unknown }).execute).toBe('function')

    // Round-trip an actual query through the acquired handle to prove it is
    // not just an object shape but a working connection end to end.
    const raw = await adapter.execute(handle, 'insert into t values (?)', [1])
    expect(fetchStub).toHaveBeenCalled()
    expect(raw.affectedRows).toBe(1)
    expect(raw.insertId).toBe(7n)

    await adapter.destroy()
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('acquire() returns a fresh handle on every call, never a shared one (regression)', async () => {
  // Regression coverage: an earlier draft of this adapter cached and shared
  // one `Connection` across every `acquire()` call, on the mistaken premise
  // that doing so was required for `capabilities.transactions: false` to be
  // safe. It's the reverse — sharing one handle across callers is exactly
  // what would make routing BEGIN/COMMIT/ROLLBACK through this adapter
  // unsafe, since knex's `db.transaction()` holds whichever handle
  // `acquire()` gives it for the transaction's whole lifetime and expects no
  // other caller to touch that same handle meanwhile. See
  // src/adapters/tidb-http.ts's doc comment for the full evidence trail.
  const originalFetch = globalThis.fetch
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: (name: string) => (name === 'TiDB-Session' ? 'sess-abc123' : null) },
    json: async () => ({ types: [], rows: [], rowsAffected: null, sLastInsertID: null }),
    text: async () => '',
  })) as unknown as typeof fetch

  try {
    const adapter = createTidbHttpAdapter({ url: 'mysql://u:p@x.tidbcloud.com:4000/db' })
    const first = await adapter.acquire()
    const second = await adapter.acquire()
    expect(second).not.toBe(first)
    await adapter.destroy()
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('throws CfKnexError.malformedResult when lastInsertId is not a numeric string', async () => {
  const execute = vi.fn().mockResolvedValue({ rows: [], rowsAffected: 1, lastInsertId: 'oops' })
  const adapter = createTidbHttpAdapter({ url: 'mysql://u:p@x.tidbcloud.com:4000/db' })

  await expect(adapter.execute({ execute }, 'insert into t values (1)', [])).rejects.toMatchObject({
    code: 'MALFORMED_DRIVER_RESULT',
  })
})

test('throws CfKnexError.malformedResult when lastInsertId is an empty string, rather than silently returning 0n', async () => {
  const execute = vi.fn().mockResolvedValue({ rows: [], rowsAffected: 1, lastInsertId: '' })
  const adapter = createTidbHttpAdapter({ url: 'mysql://u:p@x.tidbcloud.com:4000/db' })

  await expect(adapter.execute({ execute }, 'insert into t values (1)', [])).rejects.toMatchObject({
    code: 'MALFORMED_DRIVER_RESULT',
  })
})

test('throws CfKnexError.malformedResult when rowsAffected is a string instead of a number', async () => {
  const execute = vi.fn().mockResolvedValue({ rows: [], rowsAffected: '3', lastInsertId: null })
  const adapter = createTidbHttpAdapter({ url: 'mysql://u:p@x.tidbcloud.com:4000/db' })

  await expect(adapter.execute({ execute }, 'update t set x = 1', [])).rejects.toMatchObject({
    code: 'MALFORMED_DRIVER_RESULT',
  })
})

test('release() resolves without throwing (a no-op is "closing" a stateless HTTP handle)', async () => {
  const adapter = createTidbHttpAdapter({ url: 'mysql://u:p@x.tidbcloud.com:4000/db' })
  await expect(adapter.release({ execute: vi.fn() })).resolves.toBeUndefined()
})

test('destroy() is idempotent', async () => {
  const adapter = createTidbHttpAdapter({ url: 'mysql://u:p@x.tidbcloud.com:4000/db' })
  await expect(adapter.destroy()).resolves.toBeUndefined()
  await expect(adapter.destroy()).resolves.toBeUndefined()
})
