import { expect, test } from 'vitest'
import { createMysql2Adapter } from '../../src/adapters/mysql2'
import { createKnexClient } from '../../src/core/client'
import { runConformanceSuite } from '../support/conformance'

const caps = { streaming: true, transactions: true }

// Every conformance block here is conditional on a connection URL, so with no
// database configured this file would register zero tests — and vitest fails a
// file that contains no suite ("No test suite found in file"). A missing URL
// must read as "not run here", never as a failure, so each skip registers a
// named placeholder instead: the placeholder's own title, shown in the
// "skipped" list every reporter (verbose or not) prints test names for, is
// the signal that a suite was skipped and why — and the file still counts as
// a suite either way.
function skip(name: string, envVar: string) {
  test.skip(`${name} (${envVar} not set)`, () => {})
}

if (process.env.MYSQL_URL) {
  const url = process.env.MYSQL_URL
  runConformanceSuite('mysql2 (direct, MySQL 8)', () => createKnexClient(createMysql2Adapter({ url })), caps)
} else {
  skip('mysql2 (direct, MySQL 8)', 'MYSQL_URL')
}

if (process.env.MARIADB_URL) {
  const url = process.env.MARIADB_URL
  runConformanceSuite('mysql2 (direct, MariaDB 11)', () => createKnexClient(createMysql2Adapter({ url })), caps)
} else {
  skip('mysql2 (direct, MariaDB 11)', 'MARIADB_URL')
}

// A real `Hyperdrive` binding exists only inside workerd, and `mysql2` loads
// only in plain Node (see the project-split comment in vitest.config.ts) —
// the two never meet inside this test pool, so there is no way to exercise
// the adapter's `hyperdrive` branch here against a real binding. Instead,
// build a plain object shaped exactly like the five fields the adapter
// actually reads off `hyperdrive` (host, port, user, password, database) by
// parsing MYSQL_URL, and run the full conformance suite against that. The
// real binding, reached through `wrangler dev` against a live MySQL, is
// covered by the live tier instead — that is the only place a real
// `Hyperdrive` object exists to test against.
function hyperdriveFrom(url: string) {
  const u = new URL(url)
  return {
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ''),
  }
}

if (process.env.MYSQL_URL) {
  const hyperdrive = hyperdriveFrom(process.env.MYSQL_URL)
  runConformanceSuite(
    'mysql2 (via Hyperdrive-shaped config)',
    () => createKnexClient(createMysql2Adapter({ hyperdrive })),
    caps,
  )
} else {
  skip('mysql2 (via Hyperdrive-shaped config)', 'MYSQL_URL')
}

// `disableEval: true` is the one connection option this adapter must never
// let a caller lose. Workers forbid dynamic code generation at the isolate
// level, and mysql2 builds its row parser with `new Function` unless this
// flag is set — so without it *every* row-returning query on Workers fails
// with "Code generation from strings disallowed for this context", including
// a bare `SELECT 1`.
//
// Nothing else in this suite can catch that regression: Node permits `eval`,
// so an adapter that dropped the flag would still pass every conformance
// case above, and the vitest workers pool cannot import mysql2 at all (a
// module-resolution limitation of that pool, unrelated to this flag), so
// there is no in-workerd test to catch it either. Assert it on the live
// connection object instead, once per connection shape the adapter resolves.
//
// What this checks is presence, not precedence. A caller cannot currently
// smuggle `disableEval: false` in: `resolveConnectionOptions` builds a fresh
// object out of named credential fields and never forwards unknown keys, so
// reordering the spread that applies the flag is unobservable today.
// Verified by mutation — dropping the flag fails all three cases below;
// moving it ahead of the spread fails none. If a future change adds a
// pass-through for arbitrary mysql2 connection options, that ordering starts
// mattering and needs a case of its own.
if (process.env.MYSQL_URL) {
  const url = process.env.MYSQL_URL
  const hyperdrive = hyperdriveFrom(url)

  const shapes: [string, () => ReturnType<typeof createMysql2Adapter>][] = [
    ['url', () => createMysql2Adapter({ url })],
    ['hyperdrive', () => createMysql2Adapter({ hyperdrive })],
    [
      'connection credentials',
      () =>
        createMysql2Adapter({
          connection: {
            host: hyperdrive.host,
            port: hyperdrive.port,
            user: hyperdrive.user,
            password: hyperdrive.password,
            database: hyperdrive.database,
          },
        }),
    ],
  ]

  for (const [shape, build] of shapes) {
    test(`mysql2 forces disableEval on every connection (${shape})`, async () => {
      const adapter = build()
      const handle = (await adapter.acquire()) as { config: { disableEval?: unknown } }
      try {
        expect(handle.config.disableEval).toBe(true)
      } finally {
        await adapter.release(handle)
        await adapter.destroy()
      }
    })
  }
} else {
  skip('mysql2 forces disableEval on every connection', 'MYSQL_URL')
}
