import { expect, test } from 'vitest'
import { createLibsqlAdapter } from '../../src/adapters/libsql'
import { createMysql2Adapter } from '../../src/adapters/mysql2'
import { createPgAdapter } from '../../src/adapters/pg'
import { createTidbHttpAdapter } from '../../src/adapters/tidb-http'
import { createKnexClient } from '../../src/core/client'
import type { DriverAdapter } from '../../src/core/types'

// `destroy()` used to wait on tarn's pool drain with no bound, so a single
// connection the pool could not reclaim hung it forever. test/unit/destroy.test.ts
// proves the bound against a fake adapter; this file proves it against the real
// drivers, because "the pool never handed the connection back" is a claim about
// a driver's own acquire/release behaviour, not about our timer.
//
// The transaction opened below deliberately writes NOTHING. All the deadlock
// ever needed was a checked-out connection, and `BEGIN` alone provides one —
// while a write would additionally take the database-wide write lock on
// libsql/Turso (see `singleWriter` in ../support/conformance.ts) and hold it
// until the backend expired the transaction, blocking every other suite's
// writes for the duration. Reproducing the bug does not require that harm, so
// this does not cause it.
const DESTROY_BUDGET_MS = 500

// Far below the old behaviour (never) and far above the budget, so this
// separates "bounded" from "hung" without being sensitive to hosted latency.
const MUST_RETURN_WITHIN_MS = 15_000

function skip(name: string, envVar: string) {
  test.skip(`${name} (${envVar} not set)`, () => {})
}

/**
 * Opens a transaction, abandons it, and asserts `destroy()` still returns.
 *
 * The client is built here rather than shared: `destroy()` is the subject, so
 * it must not be one another test is relying on. Cleanup rolls the transaction
 * back on a best-effort basis — the assertion has already been made by then,
 * and on a backend whose adapter closed its handle during teardown the rollback
 * is moot because the connection carrying the transaction is gone with it.
 */
function runBoundedDestroySuite(name: string, makeAdapter: () => DriverAdapter) {
  test(`${name}: destroy() returns instead of hanging when a transaction is abandoned`, async () => {
    const warnings: string[] = []
    const db = createKnexClient(makeAdapter(), {
      destroyTimeoutMs: DESTROY_BUDGET_MS,
      log: { warn: (message: string) => warnings.push(message) },
    })

    const trx = await db.transaction()
    // Sanity-check the premise rather than assuming it: if `transaction()`
    // stopped checking a connection out, everything below would pass for the
    // wrong reason — `destroy()` would take the fast path and never exercise
    // the bound at all.
    expect((db.client as { pool: { numUsed(): number } }).pool.numUsed()).toBe(1)

    const startedAt = performance.now()
    await db.destroy()
    const elapsed = performance.now() - startedAt

    expect(elapsed).toBeLessThan(MUST_RETURN_WITHIN_MS)
    expect(warnings.join(' ')).toMatch(/stopped waiting for the connection pool/)

    try {
      await trx.rollback()
    } catch {
      // See the doc comment: best-effort, and irrelevant to what was asserted.
    }
  })
}

if (process.env.TIDB_URL) {
  const url = process.env.TIDB_URL
  runBoundedDestroySuite('tidb-http (TiDB Cloud Serverless)', () => createTidbHttpAdapter({ url }))
} else {
  skip('tidb-http (TiDB Cloud Serverless)', 'TIDB_URL')
}

if (process.env.TURSO_URL && process.env.TURSO_AUTH_TOKEN) {
  const url = process.env.TURSO_URL
  const authToken = process.env.TURSO_AUTH_TOKEN
  runBoundedDestroySuite('libsql (Turso, live)', () => createLibsqlAdapter({ url, authToken }))
} else {
  skip('libsql (Turso, live)', 'TURSO_URL / TURSO_AUTH_TOKEN')
}

if (process.env.LIBSQL_URL) {
  const url = process.env.LIBSQL_URL
  runBoundedDestroySuite('libsql (libsql-server, docker)', () => createLibsqlAdapter({ url }))
} else {
  skip('libsql (libsql-server, docker)', 'LIBSQL_URL')
}

if (process.env.MYSQL_URL) {
  const url = process.env.MYSQL_URL
  runBoundedDestroySuite('mysql2 (MySQL 8)', () => createMysql2Adapter({ url }))
} else {
  skip('mysql2 (MySQL 8)', 'MYSQL_URL')
}

if (process.env.POSTGRES_URL) {
  const url = process.env.POSTGRES_URL
  runBoundedDestroySuite('pg (direct)', () => createPgAdapter({ url }))
} else {
  skip('pg (direct)', 'POSTGRES_URL')
}

if (process.env.NEON_URL) {
  const url = process.env.NEON_URL
  runBoundedDestroySuite('pg (hosted: Neon)', () => createPgAdapter({ url }))
} else {
  skip('pg (hosted: Neon)', 'NEON_URL')
}
