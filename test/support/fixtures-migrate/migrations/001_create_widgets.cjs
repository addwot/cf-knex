// Fixture for test/integration/migrate.test.ts -- a real, on-disk migration
// file so that test exercises knex's actual default `FsMigrations` source
// (the same code path a real `cf-knex` consumer's `db.migrate.latest()`
// takes with no `migrationSource` override), not a stand-in.
exports.up = async function (knex) {
  await knex.schema.createTable('widgets', (t) => {
    t.increments('id')
    t.string('label')
  })
}

exports.down = async function (knex) {
  await knex.schema.dropTable('widgets')
}
