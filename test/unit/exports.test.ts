import { expect, test } from 'vitest'
import * as d1Entry from '../../src/entries/d1'
import * as mysqlEntry from '../../src/entries/mysql'
import * as postgresEntry from '../../src/entries/postgres'
import * as tidbEntry from '../../src/entries/tidb'
import * as tursoEntry from '../../src/entries/turso'
import * as root from '../../src/index'

// Exact key sets, not `.not.toContain` — catches any accidental future
// re-export (e.g. pg.ts's test-only `resolveConfig`) from any entry.
test('root entry exports exactly its public surface', () => {
  expect(Object.keys(root).sort()).toEqual(['CfKnexError', 'createClient', 'fromEnv'])
})

test.each([
  ['mysql', mysqlEntry],
  ['postgres', postgresEntry],
  ['tidb', tidbEntry],
  ['d1', d1Entry],
  ['turso', tursoEntry],
])('%s entry exports exactly createClient', (_name, entry) => {
  expect(Object.keys(entry)).toEqual(['createClient'])
})
