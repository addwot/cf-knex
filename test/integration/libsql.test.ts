import { expect, test } from 'vitest'
import { createLibsqlAdapter } from '../../src/adapters/libsql'
import { createKnexClient } from '../../src/core/client'
import { runConformanceSuite } from '../support/conformance'
import type { Client } from '@libsql/client'

// Every conformance block here is conditional on a connection URL, so with no
// database configured this file would register zero tests — and vitest fails
// a file that contains no suite ("No test suite found in file"). A missing
// URL must read as "not run here", never as a failure, so the skip below
// registers a named placeholder instead — the same pattern
// test/integration/mysql2.test.ts uses, copied rather than reinvented.
function skip(name: string, envVar: string) {
  test.skip(`${name} (${envVar} not set)`, () => {})
}

// `transactions: false`, not the `true` an earlier draft copied without
// checking: see src/adapters/libsql.ts's own doc comment for the live-server
// evidence. Every `Client.execute()` call opens and closes its own,
// independent connection (confirmed both by reading
// node_modules/@libsql/client's source and by running BEGIN/INSERT/ROLLBACK
// against the docker `libsql` service directly), so BEGIN/COMMIT/ROLLBACK
// issued as ordinary queries through this adapter's `execute()` cannot share
// a session — routing knex's `db.transaction()` through it would silently
// fail to roll back instead of failing loudly, the worst outcome this
// project's contract has. This suite exercises the `else` branch of
// `runConformanceSuite` instead, which asserts that `db.transaction()`
// rejects with a `CfKnexError` (`UNSUPPORTED_CAPABILITY`) rather than lying
// about atomicity it can't provide.
if (process.env.LIBSQL_URL) {
  const url = process.env.LIBSQL_URL
  runConformanceSuite('libsql (Turso / libsql-server, HTTP)', () => createKnexClient(createLibsqlAdapter({ url })), {
    streaming: false,
    transactions: false,
  })

  // `intMode` (see src/adapters/libsql.ts's doc comment above
  // LibsqlAdapterOptions) is private on the underlying HttpClient, so it
  // can't be pinned from a unit test with a fake handle the way the rest of
  // this adapter is -- this is the only place that can honestly assert it.
  // Live against the docker container: an id above 2^53 round-trips through
  // insertId regardless (see the bigint-insertId unit test), but *reading*
  // it back in a SELECT's row values throws under the default intMode and
  // succeeds, as a real bigint, under intMode: 'bigint'.
  test('intMode: "bigint" reads an id above 2^53 back as bigint; the default intMode throws for the same row', async () => {
    const table = `libsql_intmode_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const bigId = 9007199254740995n // 2^53 + 3

    const setupAdapter = createLibsqlAdapter({ url })
    const setupHandle = (await setupAdapter.acquire()) as Client
    try {
      await setupHandle.execute(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, name TEXT)`)
      await setupHandle.execute(`INSERT INTO ${table} (id, name) VALUES (?, ?)`, [bigId, 'x'])

      await expect(setupHandle.execute(`SELECT id FROM ${table}`)).rejects.toThrow(RangeError)
    } finally {
      await setupAdapter.release(setupHandle)
      await setupAdapter.destroy()
    }

    const bigintAdapter = createLibsqlAdapter({ url, intMode: 'bigint' })
    const bigintHandle = (await bigintAdapter.acquire()) as Client
    try {
      const result = await bigintHandle.execute(`SELECT id FROM ${table}`)
      expect(typeof result.rows[0]?.id).toBe('bigint')
      expect(result.rows[0]?.id).toBe(bigId)
    } finally {
      await bigintHandle.execute(`DROP TABLE ${table}`)
      await bigintAdapter.release(bigintHandle)
      await bigintAdapter.destroy()
    }
  })
} else {
  skip('libsql (Turso / libsql-server, HTTP)', 'LIBSQL_URL')
  skip('libsql intMode read-back', 'LIBSQL_URL')
}
