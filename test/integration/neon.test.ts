import { test } from 'vitest'
import { createPgAdapter } from '../../src/adapters/pg'
import { createKnexClient } from '../../src/core/client'
import { runConformanceSuite } from '../support/conformance'
import { runStreamingSuite } from '../support/streaming'

// This exercises the same pg adapter (src/adapters/pg.ts) as
// test/integration/pg.test.ts, through the same runConformanceSuite/
// runStreamingSuite helpers, with no code path of its own — it is a second
// *endpoint* for that one adapter, not a second backend. It lives in its own
// file, gated on its own env var, purely so POSTGRES_URL can keep pointing at
// the local docker container: pg.test.ts and streaming.test.ts depend on
// that for a hermetic, deterministic local suite, and pointing POSTGRES_URL
// at a hosted database instead would cost them that.
const caps = { streaming: true, transactions: true }

// Same reasoning as test/integration/mysql2.test.ts's `skip()`: every suite
// below is conditional on a connection URL, so with no database configured
// this file would register zero tests, and vitest fails a file with no
// suite outright ("No test suite found in file"). A named `test.skip`
// placeholder keeps the file always a valid suite and states which env var
// was missing.
function skip(name: string, envVar: string) {
  test.skip(`${name} (${envVar} not set)`, () => {})
}

if (process.env.NEON_URL) {
  const url = process.env.NEON_URL
  runConformanceSuite('pg (hosted: Neon, pooler)', () => createKnexClient(createPgAdapter({ url })), caps)
  runStreamingSuite('pg (hosted: Neon, pooler)', () => createKnexClient(createPgAdapter({ url })))
} else {
  skip('pg (hosted: Neon, pooler)', 'NEON_URL')
  skip('pg (hosted: Neon, pooler) streaming', 'NEON_URL')
}

// Same reasoning as test/integration/pg.test.ts's `hyperdriveFrom`: build a
// plain object shaped like a real `Hyperdrive` binding — all six fields
// (host, port, user, password, database, connectionString) — by parsing
// NEON_URL, and run the full conformance suite against that. See that file's
// comment for why this cannot, on its own, distinguish `resolveConfig`'s
// `{ connectionString }` return from a naive `{ ...opts.hyperdrive }` spread
// live; the structural assertion covering that already exists there, isn't
// specific to which postgres endpoint the URL points at, and so isn't
// repeated here.
function hyperdriveFrom(url: string) {
  const u = new URL(url)
  return {
    host: u.hostname,
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ''),
    connectionString: url,
  }
}

if (process.env.NEON_URL) {
  const hyperdrive = hyperdriveFrom(process.env.NEON_URL)
  runConformanceSuite(
    'pg (hosted: Neon, via Hyperdrive-shaped config)',
    () => createKnexClient(createPgAdapter({ hyperdrive })),
    caps,
  )
} else {
  skip('pg (hosted: Neon, via Hyperdrive-shaped config)', 'NEON_URL')
}

// Neon's pooler endpoint (`NEON_URL`, host ending `-pooler`) is a
// transaction-mode connection pooler; the same host with that suffix
// stripped is Neon's direct, non-pooled endpoint — a different connection
// path through the same pg adapter, not a different adapter. Confirmed live,
// ahead of writing this suite, that the direct endpoint accepts a connection
// and serves `DECLARE CURSOR` / `FETCH` across multiple batches — so a real
// `beforeAll` failure here (a wrong credential or a disabled endpoint on a
// different plan) is the intended, honest outcome for an environment where
// that no longer holds, not a bug in this suite.
function directUrlFrom(url: string): string {
  const u = new URL(url)
  u.hostname = u.hostname.replace('-pooler', '')
  return u.toString()
}

if (process.env.NEON_URL) {
  const url = directUrlFrom(process.env.NEON_URL)
  runConformanceSuite('pg (hosted: Neon, direct/non-pooler)', () => createKnexClient(createPgAdapter({ url })), caps)
  runStreamingSuite('pg (hosted: Neon, direct/non-pooler)', () => createKnexClient(createPgAdapter({ url })))
} else {
  skip('pg (hosted: Neon, direct/non-pooler)', 'NEON_URL')
  skip('pg (hosted: Neon, direct/non-pooler) streaming', 'NEON_URL')
}
