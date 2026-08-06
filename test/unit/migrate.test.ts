import { env } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { createD1Adapter } from '../../src/adapters/d1'
import { createKnexClient } from '../../src/core/client'
import { CfKnexError } from '../../src/core/errors'

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
// have disagreed before. `wrangler deploy --dry-run`'s esbuild step does
// perform this exact substitution for the relative requires `make-knex.js`
// itself issues: inspecting a real deployed bundle's output shows
// `make-knex.js` bundled in full (its `migrate`/`seed` property definitions,
// `withUserParams`, `queryBuilder` all present, nothing tree-shaken) and
// `knex/lib/util/noop.js` bundled alongside it, but no `class Migrator` and
// none of its own further dependencies (`FsMigrations`,
// `migrationListResolver`) anywhere in the output -- confirming `db.migrate`
// really does throw `TypeError: Migrator is not a constructor` in a deployed
// Worker, not merely in theory. That remapping is specific to the *relative*
// requires inside knex's own files, though: importing
// `knex/lib/migrations/migrate/Migrator.js` directly as a bare specifier
// from outside the knex package is not remapped and pulls in the real class.
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
// BEGIN/COMMIT/ROLLBACK). The test below asserts on that rejection's own
// `CfKnexError.code`, not its message: D1 itself rejects a literal `BEGIN`
// statement with an unrelated error whose message also happens to contain
// "TRANSAC", so a message-pattern match alone cannot tell this adapter's own
// declared limitation apart from D1 failing to execute the statement knex
// sent it.
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
test('db.migrate.latest() with a filesystem-free migrationSource rejects with this adapter\'s own UNSUPPORTED_CAPABILITY error -- D1 has no knex-level transaction support', async () => {
  const db = createKnexClient(createD1Adapter({ binding: env.DB }))
  await db.raw('drop table if exists widgets')
  await db.raw('drop table if exists knex_migrations')
  await db.raw('drop table if exists knex_migrations_lock')
  try {
    await db.migrate.latest({ migrationSource: inMemoryMigrationSource })
    throw new Error('expected db.migrate.latest() to reject')
  } catch (err) {
    expect(err).toBeInstanceOf(CfKnexError)
    expect((err as CfKnexError).code).toBe('UNSUPPORTED_CAPABILITY')
  }
})

// Unlike `latest()` above, `rollback()` never wraps its own call in
// `knex.transaction(...)` -- it goes straight into Migrator's `_runBatch`,
// which acquires the migration lock through its *own*, separate
// `knex.transaction(...)` call and catches whatever that rejects with,
// wrapping it in a `LockError`. Catching it is what breaks the assertion:
// Migrator's catch block logs the failure via
// `this.knex.client.logger.warn(...)` (node_modules/knex/lib/logger.js)
// before rethrowing, and that call reads `color.yellow` off `colorette` as a
// plain function argument -- evaluated unconditionally, before the logger
// ever checks whether a caller-supplied `warn` override applies -- and
// `colorette` fails to resolve under this project's vitest-pool-workers
// harness. So `db.migrate.rollback()` here always rejects with the same
// generic `TypeError: Cannot read properties of undefined (reading
// 'yellow')`, no matter what actually made the lock acquisition fail
// underneath it: confirmed by running this exact case against both a
// working and a mutated (`capabilities.transactions: true`)
// src/adapters/d1.ts and observing an identical rejection either way. No
// assertion on the rejection can tell "D1 has no transactions" apart from
// any other cause of a failed lock in this harness, so this test only pins
// "still rejects" -- not a cause.
test('db.migrate.rollback() with a filesystem-free migrationSource still rejects, but the cause is not distinguishable in this harness', async () => {
  const db = createKnexClient(createD1Adapter({ binding: env.DB }))
  await db.raw('drop table if exists widgets')
  await db.raw('drop table if exists knex_migrations')
  await db.raw('drop table if exists knex_migrations_lock')
  await expect(db.migrate.rollback({ migrationSource: inMemoryMigrationSource })).rejects.toThrow()
})

// `disableTransactions: true` only skips wrapping the migration's own up/down
// content in a transaction -- Migrator's lock step still unconditionally
// calls `knex.transaction(...)` regardless of that option, the same
// `_runBatch` path `rollback()` above takes, so this hits the identical
// colorette crash the comment above explains, confirmed the same way. This
// only pins "still rejects" -- not a cause.
test('db.migrate.latest() with disableTransactions still rejects, but the cause is not distinguishable in this harness', async () => {
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
