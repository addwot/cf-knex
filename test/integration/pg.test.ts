import { test } from 'vitest'
import { createPgAdapter } from '../../src/adapters/pg'
import { createKnexClient } from '../../src/core/client'
import { runConformanceSuite } from '../support/conformance'

const caps = { streaming: true, transactions: true }

// Same reasoning as test/integration/mysql2.test.ts's `skip()`: every
// conformance block here is conditional on a connection URL, so with no
// database configured this file would register zero tests, and vitest fails
// a file with no suite outright ("No test suite found in file"). A named
// `test.skip` placeholder — not `console.warn`, which never reaches the
// default reporter `pnpm test` uses — keeps the file always a valid suite
// and states which env var was missing.
function skip(name: string, envVar: string) {
  test.skip(`${name} (${envVar} not set)`, () => {})
}

if (process.env.POSTGRES_URL) {
  const url = process.env.POSTGRES_URL
  runConformanceSuite('pg (direct)', () => createKnexClient(createPgAdapter({ url })), caps)
} else {
  skip('pg (direct)', 'POSTGRES_URL')
}

// A real `Hyperdrive` binding exists only inside workerd, and `pg` loads only
// in plain Node (@cloudflare/vitest-pool-workers cannot import it — see the
// project-split comment in vitest.config.ts), so the two never meet inside
// this test pool and there is no way to exercise the adapter's `hyperdrive`
// branch here against a real binding. The real binding, reached through
// `wrangler dev` against a live postgres, is covered by the live tier
// instead — that is the only place a real `Hyperdrive` object exists to test
// against.
//
// Instead, build a plain object shaped like a real binding by parsing
// POSTGRES_URL, and run the full conformance suite against that — with all
// six fields a real `Hyperdrive` binding carries (`host`, `port`, `user`,
// `password`, `database`, *and* `connectionString`), not just
// `connectionString` alone. A one-field shim would pass this suite even if
// src/adapters/pg.ts spread the whole binding into pg's config instead of
// destructuring just `connectionString` out of it (see that file's
// `resolveConfig` comment for why a spread is actively wrong for pg) —
// nothing would ever populate the other five fields to go wrong. Building
// all six, exactly like a real binding would hand the adapter, is what
// actually proves the destructure is doing something.
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

if (process.env.POSTGRES_URL) {
  const hyperdrive = hyperdriveFrom(process.env.POSTGRES_URL)
  runConformanceSuite(
    'pg (via Hyperdrive-shaped config)',
    () => createKnexClient(createPgAdapter({ hyperdrive })),
    caps,
  )
} else {
  skip('pg (via Hyperdrive-shaped config)', 'POSTGRES_URL')
}
