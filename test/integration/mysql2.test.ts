import { test } from 'vitest'
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
