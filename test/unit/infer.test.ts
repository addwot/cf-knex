import { expect, test } from 'vitest'
import { CfKnexError } from '../../src/core/errors'
import { inferDriver } from '../../src/core/infer'
import type { ClientConfig } from '../../src/core/types'

const hd = { host: 'h', port: 3306, user: 'u', password: 'p', database: 'd', connectionString: 'mysql://h/d' }

// Every error-path test below goes through this so `.code` is asserted
// alongside the message on every case, not just the message text — a
// regression that fires the right message under the wrong code would
// otherwise pass undetected.
function catchCfKnexError(fn: () => unknown): CfKnexError {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(CfKnexError)
    return err as CfKnexError
  }
  throw new Error('expected function to throw a CfKnexError')
}

test.each<[string, ClientConfig, string]>([
  ['d1 binding', { engine: 'sqlite', binding: { prepare: () => {} } }, 'd1'],
  ['hyperdrive + mysql', { engine: 'mysql', hyperdrive: hd }, 'mysql2'],
  ['hyperdrive + postgres', { engine: 'postgres', hyperdrive: hd }, 'pg'],
  ['libsql url', { engine: 'sqlite', url: 'libsql://x.turso.io' }, 'libsql'],
  ['authToken', { engine: 'sqlite', url: 'https://x.turso.io', authToken: 't' }, 'libsql'],
  ['tidbcloud host', { engine: 'mysql', url: 'mysql://u:p@gateway01.eu.prod.aws.tidbcloud.com:4000/db' }, 'tidb-http'],
  ['mysql url', { engine: 'mysql', url: 'mysql://u:p@h:3306/db' }, 'mysql2'],
  ['postgres url', { engine: 'postgres', url: 'postgres://u:p@h:5432/db' }, 'pg'],
  ['postgresql url', { engine: 'postgres', url: 'postgresql://u:p@h:5432/db' }, 'pg'],
  ['credentials + mysql', { engine: 'mysql', connection: { host: 'h', user: 'u', password: 'p', database: 'd' } }, 'mysql2'],
  ['credentials + postgres', { engine: 'postgres', connection: { host: 'h', user: 'u', password: 'p', database: 'd' } }, 'pg'],
  ['uppercase scheme', { engine: 'mysql', url: 'MYSQL://u:p@h:3306/db' }, 'mysql2'],
  ['mixed-case scheme', { engine: 'postgres', url: 'Postgres://u:p@h:5432/db' }, 'pg'],
])('infers %s', (_name, config, expected) => {
  expect(inferDriver(config)).toBe(expected)
})

test('explicit driver overrides inference for TiDB Dedicated', () => {
  expect(inferDriver({ engine: 'mysql', driver: 'mysql2', url: 'mysql://u:p@x.tidbcloud.com:4000/db' })).toBe('mysql2')
})

test('rejects two connection shapes at once', () => {
  const err = catchCfKnexError(() => inferDriver({ engine: 'mysql', url: 'mysql://h/d', hyperdrive: hd }))
  expect(err.code).toBe('AMBIGUOUS_CONNECTION')
  expect(err.message).toMatch(/ambiguous connection.*'url'.*'hyperdrive'/)
})

test('rejects three connection shapes at once and lists all three, not just the first two', () => {
  const err = catchCfKnexError(() =>
    inferDriver({
      engine: 'mysql',
      url: 'mysql://h/d',
      connection: { host: 'h', user: 'u', password: 'p', database: 'd' },
      hyperdrive: hd,
    }),
  )
  expect(err.code).toBe('AMBIGUOUS_CONNECTION')
  expect(err.message).toContain("'url'")
  expect(err.message).toContain("'connection'")
  expect(err.message).toContain("'hyperdrive'")
})

test('rejects no connection at all', () => {
  const err = catchCfKnexError(() => inferDriver({ engine: 'mysql' }))
  expect(err.code).toBe('NO_CONNECTION')
  expect(err.message).toMatch(/no connection/i)
})

test('rejects an invalid engine and driver pairing', () => {
  const err = catchCfKnexError(() => inferDriver({ engine: 'sqlite', driver: 'mysql2', binding: {} }))
  expect(err.code).toBe('INVALID_ENGINE_DRIVER')
  expect(err.message).toMatch(/not valid/i)
})

test('rejects authToken paired with a mysql:// url instead of silently guessing libsql', () => {
  const err = catchCfKnexError(() => inferDriver({ engine: 'sqlite', url: 'mysql://u:p@h/db', authToken: 't' }))
  expect(err.code).toBe('UNKNOWN_DRIVER')
  expect(err.message).toContain('authToken')
  expect(err.message).toContain("'mysql://'")
})

test('rejects authToken paired with a postgres:// url', () => {
  const err = catchCfKnexError(() => inferDriver({ engine: 'sqlite', url: 'postgres://u:p@h/db', authToken: 't' }))
  expect(err.code).toBe('UNKNOWN_DRIVER')
  expect(err.message).toContain('authToken')
  expect(err.message).toContain("'postgres://'")
})

test('rejects a binding that is present but not D1-shaped', () => {
  // A KV-namespace-shaped binding dropped into the wrong config field —
  // §4.2 row 1 requires the binding to actually be a D1Database, not merely
  // present.
  const err = catchCfKnexError(() => inferDriver({ engine: 'sqlite', binding: { get: () => {}, put: () => {} } }))
  expect(err.code).toBe('UNKNOWN_DRIVER')
  expect(err.message).toMatch(/D1Database/)
  expect(err.message).toMatch(/prepare/)
})

// redact() (the string masking that keeps a password out of the
// UNKNOWN_DRIVER message below) is module-private, so it's exercised here
// through the real call site rather than as a unit in isolation — that's
// also the path an actual leak would reach a user through. Each case below
// is a distinct failure mode of an earlier, less careful version of that
// regex.
test.each<[string, string, string]>([
  ['masks simple authority userinfo', 'oracle://u:p@h:3306/db', 'oracle://***@h:3306/db'],
  ['leaves a query @ intact when there is no userinfo', 'oracle://h.example.com/db?t=a@b', 'oracle://h.example.com/db?t=a@b'],
  ['masks a password containing a literal @ in full, not just up to the first @', 'oracle://u:p@ss@h/db', 'oracle://***@h/db'],
  [
    'masks an @-containing password and leaves an unrelated query @ intact, at once',
    'oracle://u:p@ss@h/db?note=a@b',
    'oracle://***@h/db?note=a@b',
  ],
  // A malformed url — e.g. a template literal that lost its protocol prefix
  // — is exactly the caller mistake that lands here, and the anchor on
  // `scheme://` must not treat "no scheme" as "nothing to redact".
  ['masks a password on a protocol-relative url (no scheme)', '//u:pASSWORD@h/db', '//***@h/db'],
  ['masks a password on a fully schemeless url (no scheme, no //)', 'u:pASSWORD@h/db', 'u:***@h/db'],
])('redact %s', (_name, url, redacted) => {
  const err = catchCfKnexError(() => inferDriver({ engine: 'mysql', url }))
  expect(err.code).toBe('UNKNOWN_DRIVER')
  expect(err.message).toContain(redacted)
})
