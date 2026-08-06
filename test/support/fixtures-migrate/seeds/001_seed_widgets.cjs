// Fixture for test/integration/migrate.test.ts -- a real, on-disk seed file
// exercising knex's default `FsMigrations`-backed seed source. Depends on
// 001_create_widgets.cjs having already run.
exports.seed = async function (knex) {
  await knex('widgets').del()
  await knex('widgets').insert({ label: 'seeded' })
}
