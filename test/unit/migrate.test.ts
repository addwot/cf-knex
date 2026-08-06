import { env } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { createD1Adapter } from '../../src/adapters/d1'
import { createKnexClient } from '../../src/core/client'

// knex's own `package.json` `browser` field maps
// `./lib/migrations/migrate/Migrator.js` and `./lib/migrations/seed/Seeder.js`
// (the exact paths `node_modules/knex/lib/knex-builder/make-knex.js` requires
// relatively) to `./lib/util/noop.js` -- a bundler honoring that field
// substitutes a plain `function () {}` for both. If that substitution
// happened here, `db.migrate` (a getter that does `new Migrator(this)`) would
// throw "Migrator is not a constructor" the instant it's accessed, because
// `const { Migrator } = require(noop)` destructures `undefined` off a bare
// function. It does not: the tests below run the real classes. This is
// specific to `@cloudflare/vitest-pool-workers`' own module resolution --
// this project's vitest.config.ts documents that this pool uses a different
// bundler from the one `wrangler` itself builds a Worker with, and the two
// have disagreed before. Whether `wrangler deploy`'s esbuild step performs
// the substitution this file rules out here was not tested.
test('db.migrate / db.seed do not throw on access -- the real Migrator/Seeder load, not knex\'s browser-field noop stub', () => {
  const db = createKnexClient(createD1Adapter({ binding: env.DB }))
  expect(() => db.migrate).not.toThrow()
  expect(() => db.seed).not.toThrow()
  expect(typeof db.seed.run).toBe('function')
})

// Workers (and this test harness) have no real filesystem. knex's default
// migration/seed source reads a directory off disk (`FsMigrations`), so this
// fails regardless of the browser-field question above -- confirmed here
// rather than assumed, because the *reason* it fails is what determines
// whether a `migrationSource`/`seedSource` override could route around it
// (it can, see the tests below).
test('db.migrate.latest() with no migrationSource rejects -- no filesystem to read migrations from', async () => {
  const db = createKnexClient(createD1Adapter({ binding: env.DB }))
  await expect(db.migrate.latest()).rejects.toThrow(/no such file or directory|ENOENT|readdir/i)
})

test('db.seed.run() with no seedSource rejects the same way', async () => {
  const db = createKnexClient(createD1Adapter({ binding: env.DB }))
  await expect(db.seed.run()).rejects.toThrow(/no such file or directory|ENOENT|readdir/i)
})

// A `migrationSource` config option lets a caller supply migrations without
// touching the filesystem at all -- routing around the limitation above.
// That does not make `db.migrate.latest()` work against D1: knex's Migrator
// always wraps a migration run in `knex.transaction(...)` unless
// `disableTransactions: true` is set (node_modules/knex/lib/migrations/
// migrate/Migrator.js), and src/adapters/d1.ts's `transaction()` override
// unconditionally rejects (`capabilities.transactions: false` -- D1 has no
// BEGIN/COMMIT/ROLLBACK). The rejection below is this adapter's own
// declared limitation surfacing through knex's migration machinery, not a
// filesystem problem and not the browser-field stub from the test above.
const inMemoryMigrationSource = {
  getMigrations: async () => [{ name: '001_create_widgets.js' }],
  getMigrationName: (migration: { name: string }) => migration.name,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- knex's own MigrationSource.getMigration(migration) shape; this fixture ignores which one was asked for, there's only ever the one
  getMigration: async (migration: { name: string }) => ({
    up: async (knex: ReturnType<typeof createKnexClient>) => {
      await knex.schema.createTable('widgets', (t) => t.increments('id'))
    },
    down: async (knex: ReturnType<typeof createKnexClient>) => {
      await knex.schema.dropTable('widgets')
    },
  }),
}

// D1 state in this test harness outlives a single `vitest run` invocation
// (confirmed empirically -- a `knex_migrations`/`widgets` table created by an
// earlier run is still there on the next one), so each test below drops its
// own tables first rather than assuming a clean database.
test('db.migrate.latest() with a filesystem-free migrationSource still rejects -- D1 has no knex-level transaction support', async () => {
  const db = createKnexClient(createD1Adapter({ binding: env.DB }))
  await db.raw('drop table if exists widgets')
  await db.raw('drop table if exists knex_migrations')
  await db.raw('drop table if exists knex_migrations_lock')
  await expect(db.migrate.latest({ migrationSource: inMemoryMigrationSource })).rejects.toThrow(/transaction/i)
})

test('db.migrate.rollback() with a filesystem-free migrationSource rejects the same way', async () => {
  const db = createKnexClient(createD1Adapter({ binding: env.DB }))
  await db.raw('drop table if exists widgets')
  await db.raw('drop table if exists knex_migrations')
  await db.raw('drop table if exists knex_migrations_lock')
  await expect(db.migrate.rollback({ migrationSource: inMemoryMigrationSource })).rejects.toThrow()
})

// `disableTransactions: true` only skips wrapping the migration's own up/down
// content in a transaction -- Migrator's lock step (`_getLock`, the same
// file) unconditionally calls `knex.transaction(...)` to guard the
// `knex_migrations_lock` row regardless of that option, so the D1 rejection
// above still happens. In this specific harness it surfaces as an unrelated
// crash instead of a clear message: Migrator's own catch block logs the
// failure via `this.knex.client.logger.warn(...)`
// (node_modules/knex/lib/logger.js), and that call's `color.yellow` argument
// throws because `colorette` fails to resolve here -- the same
// vitest-pool-workers-specific gap src/core/client.ts's `DEFAULT_LOG`
// comment already documents for dialect-constructor logging. The assertion
// below only pins "still rejects, one way or another" -- the exact message
// is an accident of an unrelated bug in this test harness, not a contract
// this project could or should preserve.
test('db.migrate.latest() with disableTransactions still rejects -- the migration lock itself still needs a transaction', async () => {
  const db = createKnexClient(createD1Adapter({ binding: env.DB }))
  await expect(db.migrate.latest({ migrationSource: inMemoryMigrationSource, disableTransactions: true })).rejects.toThrow()
})

// Seeder (node_modules/knex/lib/migrations/seed/Seeder.js) never wraps a run
// in a transaction, so it carries none of the limitation above -- this is a
// genuine, positive result, not a skip.
test('db.seed.run() with a filesystem-free seedSource succeeds against a real D1 binding', async () => {
  const db = createKnexClient(createD1Adapter({ binding: env.DB }))
  await db.raw('drop table if exists seeded_widgets')
  await db.schema.createTable('seeded_widgets', (t) => t.increments('id'))
  const seedSource = {
    getSeeds: async () => [{ name: '001_seed_widgets.js' }],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- knex's own SeedSource.getSeed(seed) shape; this fixture ignores which one was asked for, there's only ever the one
    getSeed: async (seed: { name: string }) => ({
      seed: async (knex: ReturnType<typeof createKnexClient>) => {
        await knex('seeded_widgets').insert({})
      },
    }),
  }
  // `Seeder.run()` (node_modules/knex/lib/migrations/seed/Seeder.js) returns
  // whatever `getSeeds()` returned, unresolved -- knex's own default
  // `FsMigrations` seed source happens to return file paths, but a custom
  // source's own items pass straight through.
  const [seeds] = await db.seed.run({ seedSource })
  expect(seeds).toEqual([{ name: '001_seed_widgets.js' }])
  const rows = await db('seeded_widgets').select()
  expect(rows).toHaveLength(1)
  await db.raw('drop table if exists seeded_widgets')
})
