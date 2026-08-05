import { env } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { CfKnexError, createClient, fromEnv } from '../../src/index'

test('builds a client from a d1 binding', async () => {
  const db = createClient({ engine: 'sqlite', binding: env.DB })
  expect(await db.raw('select 1 as one')).toBeTruthy()
  await db.destroy()
})

test('rejects ambiguous connections', () => {
  expect(() => createClient({ engine: 'mysql', url: 'mysql://h/d', hyperdrive: env.HYPERDRIVE_MYSQL as never })).toThrowError(
    /ambiguous connection/,
  )
})

test('fromEnv builds a client from the one D1 binding it finds among unrelated env values', async () => {
  const db = fromEnv({ DB: env.DB, SOME_STRING: 'not a binding' })
  expect(await db.raw('select 1 as one')).toBeTruthy()
  await db.destroy()
})

test('fromEnv throws and lists candidates when two match', () => {
  expect(() => fromEnv({ DB: env.DB, HYPERDRIVE: env.HYPERDRIVE_MYSQL })).toThrowError(/ambiguous|prefer/i)
})

test('fromEnv throws when nothing matches', () => {
  expect(() => fromEnv({ SOME_STRING: 'x', SOME_NUMBER: 1 })).toThrowError(/no D1 or Hyperdrive binding/)
})

// `DB` was listed first in every other test in this file, which is also
// what `Object.values` would return first — a `prefer` implementation that
// silently ignored `opts.prefer` and always took the first match (`chosen =
// found[0]`) would still happen to pick D1 there and read as correct.
// Listing `HYPERDRIVE` first here means only a `prefer` that actually works
// picks D1 — `driverName` (not just "the query succeeded") is what proves
// which adapter was actually built, since either candidate here is a live,
// queryable binding.
test('fromEnv prefer selects the requested driver even when it is not found first', async () => {
  const db = fromEnv({ HYPERDRIVE: env.HYPERDRIVE_MYSQL, DB: env.DB }, { prefer: 'd1' })
  expect(db.client.driverName).toBe('sqlite3')
  await db.destroy()
})

test('fromEnv throws when prefer matches none of the candidates found', () => {
  expect(() => fromEnv({ DB: env.DB }, { prefer: 'pg' })).toThrowError(/no binding matched/)
})

// An explicit `driver` skips inferDriver's shape-based inference entirely
// (see core/infer.ts's `infer()`), so a caller naming a driver can supply a
// config shaped for a completely different one — the three cases below each
// reproduce that exact mismatch for a driver that does not self-validate
// (unlike pg/mysql2's own factories). Each must fail with a CfKnexError
// naming the actual missing field, not a driver-internal error about the
// literal string "undefined".
function expectMissingField(thrower: () => unknown, field: string) {
  expect.assertions(3)
  try {
    thrower()
  } catch (err) {
    expect(err).toBeInstanceOf(CfKnexError)
    expect((err as CfKnexError).code).toBe('NO_CONNECTION')
    expect((err as CfKnexError).message).toContain(`'${field}'`)
  }
}

test('createClient rejects driver=libsql given a binding instead of a url', () => {
  expectMissingField(() => createClient({ engine: 'sqlite', driver: 'libsql', binding: env.DB }), 'url')
})

test('createClient rejects driver=d1 given a url instead of a binding', () => {
  expectMissingField(() => createClient({ engine: 'sqlite', driver: 'd1', url: 'https://example.com' }), 'binding')
})

test('createClient rejects driver=tidb-http given a connection instead of a url', () => {
  const connection = { host: 'h', user: 'u', password: 'p', database: 'd' }
  expectMissingField(() => createClient({ engine: 'mysql', driver: 'tidb-http', connection }), 'url')
})

// `{ connectionString: 123 }` and `{ connectionString: undefined }` both
// satisfy `'connectionString' in value` while carrying no real string to
// call `.startsWith()` on — a config value shaped this way (a copy-paste
// from the wrong binding type, or a field that lost its value) must read as
// "not a Hyperdrive binding, keep scanning" rather than crash `fromEnv`
// itself with an unrelated raw TypeError.
test('fromEnv treats a malformed connectionString as a non-match instead of throwing a raw TypeError', () => {
  expect(() => fromEnv({ WEIRD: { connectionString: 123 }, ALSO_WEIRD: { connectionString: undefined } })).toThrowError(
    /no D1 or Hyperdrive binding/,
  )
})
