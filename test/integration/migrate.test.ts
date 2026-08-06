import { fileURLToPath } from 'node:url'
import type { Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createMysql2Adapter } from '../../src/adapters/mysql2'
import { createKnexClient } from '../../src/core/client'

// No `node:path` here -- this project carries no @types/node (see
// test/process.d.ts) and test/node-builtins.d.ts's narrow shim for
// `node:url` already covers what's needed; `new URL(relative, import.meta.url)`
// does the same job `path.join(__dirname, …)` would, the same approach
// test/integration/esm-resolution.test.ts already uses for its own repoRoot.
const migrationsDir = fileURLToPath(new URL('../support/fixtures-migrate/migrations', import.meta.url))
const seedsDir = fileURLToPath(new URL('../support/fixtures-migrate/seeds', import.meta.url))

// knex's `db.migrate`/`db.seed` are plain getters on the object `Knex(...)`
// returns (node_modules/knex/lib/knex-builder/make-knex.js), independent of
// which `Client` subclass backs a given knex instance -- `createKnexClient`
// (src/core/client.ts) only overrides connection acquisition and query
// execution, never touches `make-knex.js` or knex's migration/seed modules.
// This suite's only job is confirming that, for a driver-backed adapter that
// runs in plain Node (real TCP socket, real transactions), the conventional,
// filesystem-based `db.migrate.latest()` / `.rollback()` / `db.seed.run()`
// flow -- the one knex's own docs describe, no `migrationSource` override --
// genuinely works end to end through this wrapper. See test/unit/migrate.test.ts
// for the same question inside workerd, where the answer differs.
if (process.env.MYSQL_URL) {
  describe('migrations and seeds (mysql2, plain Node)', () => {
    let db: Knex

    beforeAll(async () => {
      db = createKnexClient(createMysql2Adapter({ url: process.env.MYSQL_URL! }))
      // Idempotent: a prior failed run may have left these behind.
      await db.raw('drop table if exists widgets')
      await db.raw('drop table if exists knex_migrations')
      await db.raw('drop table if exists knex_migrations_lock')
    })

    afterAll(async () => {
      await db.raw('drop table if exists widgets').catch(() => {})
      await db.raw('drop table if exists knex_migrations').catch(() => {})
      await db.raw('drop table if exists knex_migrations_lock').catch(() => {})
      await db.destroy()
    })

    // Ordered on purpose: `seed` depends on `latest` having created `widgets`,
    // and `rollback` depends on `latest` having run it -- mirroring how a real
    // consumer would call these in sequence, not three independent probes.
    test('db.migrate.latest() runs the on-disk migration', async () => {
      const [batchNo, migrations] = await db.migrate.latest({ directory: migrationsDir })
      expect(batchNo).toBe(1)
      expect(migrations).toEqual(['001_create_widgets.cjs'])
      const tables = await db.raw("show tables like 'widgets'")
      expect(tables[0]).toHaveLength(1)
    })

    test('db.seed.run() runs the on-disk seed', async () => {
      const [seedFiles] = await db.seed.run({ directory: seedsDir })
      expect(seedFiles).toEqual([`${seedsDir}/001_seed_widgets.cjs`])
      const rows = await db('widgets').select()
      expect(rows).toEqual([{ id: 1, label: 'seeded' }])
    })

    test('db.migrate.rollback() undoes the migration', async () => {
      const [batchNo, migrations] = await db.migrate.rollback({ directory: migrationsDir })
      expect(batchNo).toBe(1)
      expect(migrations).toEqual(['001_create_widgets.cjs'])
      const tables = await db.raw("show tables like 'widgets'")
      expect(tables[0]).toHaveLength(0)
    })
  })
} else {
  test.skip('migrations and seeds (mysql2, plain Node) (MYSQL_URL not set)', () => {})
}
