import { createMysql2Adapter } from '../../src/adapters/mysql2'
import { createKnexClient } from '../../src/core/client'
import { runConformanceSuite } from '../support/conformance'

const caps = { streaming: true, transactions: true }

if (process.env.MYSQL_URL) {
  const url = process.env.MYSQL_URL
  runConformanceSuite('mysql2 (direct, MySQL 8)', () => createKnexClient(createMysql2Adapter({ url })), caps)
} else {
  console.warn('SKIP mysql2 direct — MYSQL_URL not set')
}

if (process.env.MARIADB_URL) {
  const url = process.env.MARIADB_URL
  runConformanceSuite('mysql2 (direct, MariaDB 11)', () => createKnexClient(createMysql2Adapter({ url })), caps)
} else {
  console.warn('SKIP mysql2 mariadb — MARIADB_URL not set')
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
  console.warn('SKIP mysql2 hyperdrive-shaped — MYSQL_URL not set')
}
