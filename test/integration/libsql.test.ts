import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createLibsqlAdapter } from '../../src/adapters/libsql'
import { createKnexClient } from '../../src/core/client'
import { runConformanceSuite } from '../support/conformance'
import type { LibsqlAdapterOptions } from '../../src/adapters/libsql'
import type { Client } from '@libsql/client'
import type { Knex } from 'knex'

// Every conformance block here is conditional on a connection URL, so with no
// database configured this file would register zero tests — and vitest fails
// a file that contains no suite ("No test suite found in file"). A missing
// URL must read as "not run here", never as a failure, so the skip below
// registers a named placeholder instead — the same pattern
// test/integration/mysql2.test.ts uses, copied rather than reinvented.
function skip(name: string, envVar: string) {
  test.skip(`${name} (${envVar} not set)`, () => {})
}

// Coverage `runConformanceSuite` itself doesn't reach: a nested transaction's
// savepoint path, a raw BEGIN/COMMIT pair issued outside db.transaction(),
// and the two `SET TRANSACTION` branches (isolation level, read-only) —
// src/adapters/libsql.ts's execute() doc comment for what routes each
// statement where. Shared by both the docker and the live Turso suites below
// rather than duplicated.
function runLibsqlTransactionTests(name: string, adapterOptions: LibsqlAdapterOptions) {
  describe(`libsql real transactions: ${name}`, () => {
    let db: Knex
    const table = `cf_knex_libsql_tx_${Math.random().toString(36).slice(2, 10)}`

    beforeAll(async () => {
      db = createKnexClient(createLibsqlAdapter(adapterOptions))
      await db.schema.createTable(table, (t) => {
        t.increments('id')
        t.string('name')
      })
    })

    afterAll(async () => {
      await db.schema.dropTableIfExists(table)
      await db.destroy()
    })

    test('a nested db.transaction() rolls back independently of its parent (savepoint path)', async () => {
      await db.transaction(async (trx) => {
        await trx(table).insert({ name: 'nest-outer' })
        await expect(
          trx.transaction(async (trx2) => {
            await trx2(table).insert({ name: 'nest-inner' })
            throw new Error('nested rollback')
          }),
        ).rejects.toThrow('nested rollback')
      })

      expect(await db(table).where('name', 'nest-outer').first()).toBeTruthy()
      expect(await db(table).where('name', 'nest-inner').first()).toBeFalsy()
    })

    test("db.raw('BEGIN') followed by ordinary queries does not strand the connection", async () => {
      await db.raw('BEGIN')
      await db(table).insert({ name: 'raw-begin' })
      await db.raw('COMMIT')
      expect(await db(table).where('name', 'raw-begin').first()).toBeTruthy()

      // If the BEGIN/COMMIT pair above left the adapter's own bookkeeping
      // out of sync (e.g. the WeakMap entry not cleared on COMMIT), this
      // query would land on a handle the adapter still believes is
      // mid-transaction and either misroute or fail outright.
      await db(table).insert({ name: 'after-raw-begin' })
      expect(await db(table).where('name', 'after-raw-begin').first()).toBeTruthy()
    })

    // D2 end-to-end smoke test: acquires the adapter directly (bypassing
    // knex's own pool, which never tears down a handle mid-transaction on
    // its own) so release() runs on a handle it genuinely still owns an open
    // Transaction for, then re-reads the table through a second, independent
    // handle to confirm the write never became visible.
    //
    // This does not, on its own, prove release() calls rollback(): mutation
    // testing this exact line found that @libsql/client's HttpClient.close()
    // already tears down a pending transaction as a side effect of closing
    // its underlying stream, live-confirmed by abandoning a transaction with
    // only close() -- rollback() never called -- and finding a later writer
    // still unblocked. So this test would still pass even if release()'s own
    // rollback call were removed. It's kept anyway as a real end-to-end
    // check that nothing here crashes or corrupts data; test/unit/
    // libsql.test.ts's "release() rolls back a transaction still open on the
    // handle before closing it" is what actually pins the rollback() call
    // itself, via a spy, and is mutation-sensitive to it.
    test('release() rolls back a transaction still open on the handle instead of stranding it', async () => {
      const adapter = createLibsqlAdapter(adapterOptions)
      const handle = await adapter.acquire()
      await adapter.execute(handle, 'BEGIN', [])
      await adapter.execute(handle, `INSERT INTO ${table} (name) VALUES (?)`, ['abandoned-by-release'])
      await adapter.release(handle)

      const checkHandle = await adapter.acquire()
      const result = await adapter.execute(checkHandle, `SELECT * FROM ${table} WHERE name = ?`, [
        'abandoned-by-release',
      ])
      await adapter.release(checkHandle)
      await adapter.destroy()

      expect(result.rows).toHaveLength(0)
    })

    // Exercised via db.raw(), not db.transaction(fn, { isolationLevel }) --
    // knex's own sqlite dialect (node_modules/knex/lib/dialects/sqlite3/
    // execution/sqlite-transaction.js's Transaction_Sqlite.begin(), which
    // Client_SQLite3.prototype.transaction() selects instead of the generic
    // lib/execution/transaction.js) intercepts `isolationLevel` before any
    // SQL is generated: it calls `this.client.logger.warn(...)` and sends a
    // plain `BEGIN;` regardless, so `SET TRANSACTION ISOLATION LEVEL …;`
    // never reaches this adapter's execute() through that config option --
    // confirmed live, both by the literal warning text on stderr and by this
    // suite's own now-abandoned first draft of this test (`db.transaction(fn,
    // { isolationLevel: 'serializable' })`), which resolved instead of
    // rejecting. db.raw() is the only route that actually reaches the SQL
    // text this adapter matches, so it's what proves the adapter's own
    // handling of it is correct.
    test('SET TRANSACTION ISOLATION LEVEL throws rather than being silently accepted', async () => {
      await expect(db.raw('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE')).rejects.toMatchObject({
        code: 'ISOLATION_LEVEL_NOT_CONFIGURABLE',
      })
    })

    // Same caveat as the isolation-level test above: `db.transaction(fn, {
    // readOnly: true })` never reaches this adapter either -- Transaction_Sqlite.begin()
    // warns ("sqlite3 implicitly handles read vs write transactions") and
    // sends plain `BEGIN;` regardless of `readOnly`. `SET TRANSACTION READ
    // ONLY;` then `BEGIN;`, issued directly, is what actually reaches
    // execute()'s D3 branch and opens a `'read'`-mode Transaction.
    //
    // What this test does NOT assert, and why: @libsql/core's own
    // TransactionMode doc comment says a `'read'` transaction "will not
    // accept write statements", and that's what this test originally
    // asserted. Verified live -- docker libsql-server and hosted Turso both
    // -- that this is false: an INSERT inside a `client.transaction('read')`
    // succeeds, and the row is still there after commit() and a fresh
    // SELECT on a different connection. So a write genuinely does go through
    // in `'read'` mode; asserting otherwise would just be a wrong test.
    //
    // What IS real and driver-verified about `'read'` mode: unlike a write
    // (autocommit or transacted), it does not queue behind another
    // connection's already-open write transaction -- confirmed against both
    // backends by timing a `'read'`-mode SELECT against a concurrently held
    // write transaction (resolves in single-digit ms) versus an autocommit
    // write racing the same held transaction (blocks until the holder
    // commits). That's the property this test pins instead: it only passes
    // if BEGIN after SET TRANSACTION READ ONLY genuinely opened in `'read'`
    // mode -- if that mapping were dropped and BEGIN defaulted to `'write'`
    // instead, this SELECT would queue behind the held transaction like the
    // autocommit write does, and the assertion below would fail.
    test('SET TRANSACTION READ ONLY opens the next BEGIN as a read-mode transaction that does not queue behind a concurrent write', async () => {
      const writeHolder = await db.transaction()
      await writeHolder(table).insert({ name: 'holds-write-lock' })

      const blockedWrite = db(table)
        .insert({ name: 'queued-behind-write-lock' })
        .then(() => 'resolved' as const)

      try {
        await db.raw('SET TRANSACTION READ ONLY')
        await db.raw('BEGIN')
        const readResult = await Promise.race([
          db(table)
            .select('*')
            .then(() => 'resolved' as const),
          blockedWrite.then(() => 'write-resolved-first' as const),
        ])
        await db.raw('ROLLBACK')

        expect(readResult).toBe('resolved')
      } finally {
        await writeHolder.commit()
      }

      expect(await blockedWrite).toBe('resolved')
    })
  })
}

if (process.env.LIBSQL_URL) {
  const url = process.env.LIBSQL_URL
  runConformanceSuite('libsql (Turso / libsql-server, HTTP)', () => createKnexClient(createLibsqlAdapter({ url })), {
    streaming: false,
    transactions: true,
  })
  runLibsqlTransactionTests('libsql-server, docker', { url })

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
  skip('libsql real transactions (libsql-server, docker)', 'LIBSQL_URL')
  skip('libsql intMode read-back', 'LIBSQL_URL')
}

// A live Turso database, distinct from the docker `libsql-server` above:
// same wire protocol and the same @libsql/client build reaches both, but
// only Turso proves this adapter against the real hosted service the
// package's own README names as a target, not just a same-shape local
// stand-in.
if (process.env.TURSO_URL && process.env.TURSO_AUTH_TOKEN) {
  const url = process.env.TURSO_URL
  const authToken = process.env.TURSO_AUTH_TOKEN
  runConformanceSuite('libsql (Turso, live)', () => createKnexClient(createLibsqlAdapter({ url, authToken })), {
    streaming: false,
    transactions: true,
  })
  runLibsqlTransactionTests('Turso, live', { url, authToken })
} else {
  skip('libsql (Turso, live)', 'TURSO_URL / TURSO_AUTH_TOKEN')
  skip('libsql real transactions (Turso, live)', 'TURSO_URL / TURSO_AUTH_TOKEN')
}
