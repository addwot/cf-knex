import { expect, test } from 'vitest'
import { inferDriver, redact } from '../../src/core/infer'
import type { ClientConfig } from '../../src/core/types'

const hd = { host: 'h', port: 3306, user: 'u', password: 'p', database: 'd', connectionString: 'mysql://h/d' }

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
])('infers %s', (_name, config, expected) => {
  expect(inferDriver(config)).toBe(expected)
})

test('explicit driver overrides inference for TiDB Dedicated', () => {
  expect(inferDriver({ engine: 'mysql', driver: 'mysql2', url: 'mysql://u:p@x.tidbcloud.com:4000/db' })).toBe('mysql2')
})

test('rejects two connection shapes at once', () => {
  expect(() => inferDriver({ engine: 'mysql', url: 'mysql://h/d', hyperdrive: hd }))
    .toThrowError(/ambiguous connection.*'url'.*'hyperdrive'/)
})

test('rejects no connection at all', () => {
  expect(() => inferDriver({ engine: 'mysql' })).toThrowError(/no connection/i)
})

test('rejects an invalid engine and driver pairing', () => {
  expect(() => inferDriver({ engine: 'sqlite', driver: 'mysql2', binding: {} })).toThrowError(/INVALID|not valid/i)
})

// redact() feeds directly into error messages and logs — a password that
// survives it is a real leak, not a formatting nit. Each case below is a
// distinct failure mode of the brief's original unanchored regex
// (`/\/\/[^@]*@/`), which matched `[^@]*` straight through the first `/`
// after the authority and mangled anything with an `@` later in the URL.
test('redact masks userinfo in the authority', () => {
  expect(redact('mysql://u:p@h:3306/db')).toBe('mysql://***@h:3306/db')
})

test('redact leaves an @ in the path or query intact', () => {
  expect(redact('https://x.turso.io/db?t=a@b')).toBe('https://x.turso.io/db?t=a@b')
})

test('redact masks a password and leaves a separate @ in the query intact, at once', () => {
  expect(redact('mysql://u:p@h:3306/db?note=a@b')).toBe('mysql://***@h:3306/db?note=a@b')
})
