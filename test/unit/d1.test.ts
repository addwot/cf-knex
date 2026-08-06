import { env } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { createD1Adapter } from '../../src/adapters/d1'
import { createKnexClient } from '../../src/core/client'
import { CfKnexError } from '../../src/core/errors'
import { runConformanceSuite } from '../support/conformance'

// `env.DB` only exists inside workerd (see this project's vitest.config.ts —
// this file lives under test/unit, the `workers` project, specifically
// because of that), backed by the real D1 implementation
// `@cloudflare/vitest-pool-workers` wires up, not a hand-rolled stub.
runConformanceSuite('d1', () => createKnexClient(createD1Adapter({ binding: env.DB })), {
  streaming: false,
  transactions: false,
})

test('transaction error names batch() as the alternative, with what it actually gives a caller', async () => {
  const db = createKnexClient(createD1Adapter({ binding: env.DB }))
  await expect(db.transaction(async () => {})).rejects.toThrow(/batch\(\)/)
  // The core-level fallback wording (generic vs. adapter-supplied hint) is
  // already covered by test/unit/client.test.ts's own hint-fallback tests
  // against a fake adapter — this only asserts *this* adapter's own hint
  // text, which is this file's responsibility, not core's.
  await expect(db.transaction(async () => {})).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' })
  await expect(db.transaction(async () => {})).rejects.toThrow(/atomic/)
  await db.destroy()
})

test('declares dialect sqlite, driver d1, no streaming, no transactions', () => {
  const adapter = createD1Adapter({ binding: env.DB })
  expect(adapter.dialect).toBe('sqlite')
  expect(adapter.driver).toBe('d1')
  expect(adapter.capabilities.streaming).toBe(false)
  expect(adapter.capabilities.transactions).toBe(false)
})

test('omits validate() entirely -- a binding-backed handle has no session to go stale', () => {
  const adapter = createD1Adapter({ binding: env.DB })
  expect(adapter.validate).toBeUndefined()
})

test('omits stream() entirely -- consistent with capabilities.streaming: false', () => {
  const adapter = createD1Adapter({ binding: env.DB })
  expect(adapter.stream).toBeUndefined()
})

test('acquire() returns a fresh wrapper every call, but every wrapper still routes to the same underlying binding', async () => {
  // Regression guard for this adapter's two-part design: a fresh, disposable
  // `{ prepare }` object per acquire() call (so knex's pool has something of
  // its own to mark `__knex__disposed` on, never the caller's shared
  // binding — see acquire()'s own comment in src/adapters/d1.ts), while still
  // funnelling every one of those wrappers to the one real `D1Database`
  // underneath (see this function's doc comment, "Routing every acquire()
  // call through one underlying binding", for the evidence that sharing it
  // this way is safe).
  const calls: string[] = []
  const stmt = { bind: () => stmt, all: async () => ({ success: true, results: [], meta: { last_row_id: 0, changes: 0 } }) }
  const binding = {
    prepare: (query: string) => {
      calls.push(query)
      return stmt
    },
  }
  const adapter = createD1Adapter({ binding })
  const first = await adapter.acquire()
  const second = await adapter.acquire()
  // Not the binding itself, and not the same wrapper object either.
  expect(first).not.toBe(binding)
  expect(second).not.toBe(binding)
  expect(first).not.toBe(second)
  // But both still forward prepare() to the one binding underneath.
  ;(first as { prepare(q: string): unknown }).prepare('select 1')
  ;(second as { prepare(q: string): unknown }).prepare('select 2')
  expect(calls).toEqual(['select 1', 'select 2'])
})

// The three tests below are assumption-pinning, not regression guards for
// this adapter's own code: they assert platform invariants of the real D1
// binding itself (true regardless of anything createD1Adapter does), which
// is exactly why they still pass if acquire()'s wrapper fix above is
// reverted. What they pin is the *premise* src/adapters/d1.ts's doc comment
// ("Routing every acquire() call through one underlying binding") rests
// its safety argument on -- if D1 ever started handing back a shared or
// mutated statement, these would fail and that argument would need
// revisiting. The wrapper fix itself is guarded separately, below.

test('prepare() on the real binding returns a brand-new statement on every call', () => {
  const s1 = env.DB.prepare('SELECT 1')
  const s2 = env.DB.prepare('SELECT 1')
  expect(s1).not.toBe(s2)
})

test("bind() on the real binding returns a new statement, it does not mutate the one it's called on", () => {
  // Binding one caller's values does not leave any trace on the unbound
  // statement a second caller might still hold a reference to.
  const base = env.DB.prepare('SELECT ?1 as v')
  const bound1 = base.bind('a')
  const bound2 = base.bind('b')
  expect(bound1).not.toBe(base)
  expect(bound2).not.toBe(base)
  expect(bound1).not.toBe(bound2)
})

test('an INSERT through one acquire() handle does not corrupt or leak into an unrelated SELECT through another', async () => {
  // Ties the two platform invariants above together end to end, through
  // this adapter (not just the raw binding): two separate acquire()
  // wrappers over the same underlying binding, one mutating, one reading,
  // show no cross-talk. Passes against essentially any non-broken
  // implementation -- it is not a strong guard on its own, but it does
  // exercise the adapter's real execute() path the two tests above don't.
  const adapter = createD1Adapter({ binding: env.DB })
  const writer = await adapter.acquire()
  const reader = await adapter.acquire()
  try {
    await adapter.execute(
      writer,
      'CREATE TABLE IF NOT EXISTS d1_adapter_crosstalk_test (id integer primary key, name text)',
      [],
    )
    await adapter.execute(writer, 'INSERT INTO d1_adapter_crosstalk_test (name) VALUES (?1)', ['alice'])
    const result = await adapter.execute(reader, 'SELECT name FROM d1_adapter_crosstalk_test', [])
    expect(result.rows).toEqual([{ name: 'alice' }])
  } finally {
    // Runs even if an assertion above throws, so a failed run doesn't leave
    // the table behind for the next test in this file to trip over.
    await adapter.execute(writer, 'DROP TABLE IF EXISTS d1_adapter_crosstalk_test', [])
  }
})

test('a real query through this adapter never marks env.DB itself -- __knexUid / __knex__disposed stay off the shared binding', async () => {
  // The actual regression guard for this fix round's central change: knex's
  // pool writes __knexUid onto whatever acquireRawConnection() returns (to
  // track it internally), and connection.__knex__disposed on a failure path
  // (see acquire()'s own comment in src/adapters/d1.ts for the exact knex
  // source lines) -- neither may ever land on the caller's own, long-lived
  // env.DB, or every future pool built over that binding would be poisoned
  // for the isolate's lifetime. This fails if acquire() below is reverted
  // to `return opts.binding` directly (confirmed by hand against that
  // revert: __knexUid appears on env.DB after the query, and this
  // assertion fails).
  const before = Object.getOwnPropertyNames(env.DB)
  expect(before).not.toContain('__knexUid')
  expect(before).not.toContain('__knex__disposed')
  const db = createKnexClient(createD1Adapter({ binding: env.DB }))
  await db.raw('SELECT 1')
  await db.destroy()
  const after = Object.getOwnPropertyNames(env.DB)
  expect(after).not.toContain('__knexUid')
  expect(after).not.toContain('__knex__disposed')
})

test('the real binding throws D1_TYPE_ERROR on a raw Date binding -- the reason CfKnexClient.prepBindings must convert it first', () => {
  // Pins the fact src/adapters/d1.ts's doc comment now explains: the real
  // binding still throws on an unconverted Date exactly as before -- what
  // changed is that `../core/client.ts`'s `CfKnexClient.prepBindings` never
  // lets one reach here anymore (see the round-trip test below). This test
  // fails loudly if D1 ever starts accepting Date directly, at which point
  // that documentation would otherwise go silently stale. bind() itself
  // throws synchronously here (confirmed by the stack trace: `D1PreparedStatement
  // .bind`, not `.all()`), so this is a plain throwing-function assertion,
  // not an async rejection one.
  expect(() => env.DB.prepare('SELECT ?1 as d').bind(new Date())).toThrow(/D1_TYPE_ERROR/)
})

test('the real binding also throws D1_TYPE_ERROR on a bigint binding -- a known, currently unfixed limitation', () => {
  // Unlike Date/boolean, a bigint binding gets no conversion from
  // CfKnexClient.prepBindings (src/core/client.ts) -- knex's own
  // better-sqlite3 dialect, the reference this project's sqlite-path
  // conversion matches, doesn't convert bigint either, so this project
  // deliberately doesn't invent a conversion beyond that reference. D1 still
  // rejects a bigint binding the same way it used to reject Date; this test
  // pins that as a documented, real, measured gap (src/adapters/d1.ts's doc
  // comment), not an oversight.
  expect(() => env.DB.prepare('SELECT ?1 as v').bind(42n)).toThrow(/D1_TYPE_ERROR/)
})

test('a Date and a boolean bound through a real insert round-trip as an epoch-ms number and 0/1, not as a thrown error', async () => {
  // The actual regression guard for the fix: before CfKnexClient.prepBindings
  // existed, this exact insert threw D1_TYPE_ERROR (see the raw-binding test
  // above for why) instead of ever reaching a SELECT. Asserting the *type*
  // of what comes back, not just that a row exists, is what catches a
  // conversion that silently produces the wrong shape (e.g. an ISO string)
  // instead of matching knex's own better-sqlite3 semantics.
  const db = createKnexClient(createD1Adapter({ binding: env.DB }))
  const table = `d1_bindings_roundtrip_${Date.now()}`
  const when = new Date(1577934245000)
  try {
    await db.schema.createTable(table, (t) => {
      t.increments('id')
      t.specificType('created_at', 'blob')
      t.specificType('flag', 'blob')
    })
    await db(table).insert({ created_at: when, flag: true })
    const row = (await db(table).first()) as { created_at: unknown; flag: unknown }
    expect(typeof row.created_at).toBe('number')
    expect(row.created_at).toBe(when.valueOf())
    expect(typeof row.flag).toBe('number')
    expect(row.flag).toBe(1)
  } finally {
    await db.schema.dropTableIfExists(table)
    await db.destroy()
  }
})

test('release() resolves without throwing (a no-op is "closing" a handle with nothing to close)', async () => {
  const adapter = createD1Adapter({ binding: env.DB })
  await expect(adapter.release(env.DB)).resolves.toBeUndefined()
})

test('destroy() is idempotent', async () => {
  const adapter = createD1Adapter({ binding: env.DB })
  await expect(adapter.destroy()).resolves.toBeUndefined()
  await expect(adapter.destroy()).resolves.toBeUndefined()
})

test('execute() always calls bind(), even with zero bindings, and passes the SQL and bindings through', async () => {
  const all = async () => ({ success: true, results: [{ id: 1 }], meta: { last_row_id: 0, changes: 0 } })
  const bound = { bind: () => bound, all }
  const bind = (...args: unknown[]) => {
    expect(args).toEqual([])
    return bound
  }
  const prepare = (sql: string) => {
    expect(sql).toBe('select 1')
    return { bind, all }
  }
  const binding = { prepare }
  const adapter = createD1Adapter({ binding })
  const raw = await adapter.execute(await adapter.acquire(), 'select 1', [])
  expect(raw.rows).toEqual([{ id: 1 }])
})

test('maps meta.last_row_id / meta.changes to insertId / affectedRows', async () => {
  const stmt = {
    bind: () => stmt,
    all: async () => ({ success: true, results: [], meta: { last_row_id: 42, changes: 3 } }),
  }
  const binding = { prepare: () => stmt }
  const adapter = createD1Adapter({ binding })
  const raw = await adapter.execute(await adapter.acquire(), 'insert into t values (1)', [1])
  expect(raw.insertId).toBe(42)
  expect(raw.affectedRows).toBe(3)
  expect(raw.rows).toEqual([])
})

test('throws CfKnexError.malformedResult when .all() resolves to null', async () => {
  const stmt = { bind: () => stmt, all: async () => null }
  const binding = { prepare: () => stmt }
  const adapter = createD1Adapter({ binding })
  await expect(adapter.execute(await adapter.acquire(), 'select 1', [])).rejects.toMatchObject({
    code: 'MALFORMED_DRIVER_RESULT',
  })
})

test('throws CfKnexError.malformedResult when .all() resolves to an array instead of a D1Result object', async () => {
  const stmt = { bind: () => stmt, all: async () => [{ id: 1 }] }
  const binding = { prepare: () => stmt }
  const adapter = createD1Adapter({ binding })
  await expect(adapter.execute(await adapter.acquire(), 'select 1', [])).rejects.toMatchObject({
    code: 'MALFORMED_DRIVER_RESULT',
  })
})

test("throws CfKnexError.malformedResult when 'results' is missing or not an array", async () => {
  const stmt = { bind: () => stmt, all: async () => ({ success: true, meta: { last_row_id: 0, changes: 0 } }) }
  const binding = { prepare: () => stmt }
  const adapter = createD1Adapter({ binding })
  await expect(adapter.execute(await adapter.acquire(), 'select 1', [])).rejects.toMatchObject({
    code: 'MALFORMED_DRIVER_RESULT',
  })
})

test("throws CfKnexError.malformedResult when 'meta' is missing or not an object", async () => {
  const stmt = { bind: () => stmt, all: async () => ({ success: true, results: [] }) }
  const binding = { prepare: () => stmt }
  const adapter = createD1Adapter({ binding })
  await expect(adapter.execute(await adapter.acquire(), 'select 1', [])).rejects.toMatchObject({
    code: 'MALFORMED_DRIVER_RESULT',
  })
})

test("throws CfKnexError.malformedResult when 'meta.last_row_id' is missing or not a number", async () => {
  const stmt = { bind: () => stmt, all: async () => ({ success: true, results: [], meta: { changes: 0 } }) }
  const binding = { prepare: () => stmt }
  const adapter = createD1Adapter({ binding })
  await expect(adapter.execute(await adapter.acquire(), 'select 1', [])).rejects.toMatchObject({
    code: 'MALFORMED_DRIVER_RESULT',
  })
})

test("throws CfKnexError.malformedResult when 'meta.changes' is missing or not a number", async () => {
  const stmt = { bind: () => stmt, all: async () => ({ success: true, results: [], meta: { last_row_id: 0 } }) }
  const binding = { prepare: () => stmt }
  const adapter = createD1Adapter({ binding })
  await expect(adapter.execute(await adapter.acquire(), 'select 1', [])).rejects.toMatchObject({
    code: 'MALFORMED_DRIVER_RESULT',
  })
})

test('a real SQL error against the D1 binding rejects execute(), it does not resolve with an empty/malformed result', async () => {
  // Confirms, through this adapter (not just the raw binding), the empirical
  // finding documented in src/adapters/d1.ts's toRawResult comment: D1
  // rejects on a query error rather than resolving with `success: false`, so
  // there is no "resolved but unsuccessful" shape for toRawResult to guard.
  const adapter = createD1Adapter({ binding: env.DB })
  const handle = await adapter.acquire()
  await expect(adapter.execute(handle, 'select * from this_table_does_not_exist_at_all', [])).rejects.toThrow()
  await expect(adapter.execute(handle, 'select * from this_table_does_not_exist_at_all', [])).rejects.not.toBeInstanceOf(
    CfKnexError,
  )
})
