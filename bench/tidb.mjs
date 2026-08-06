#!/usr/bin/env node
// What does cf-knex cost you, over calling @tidbcloud/serverless by hand?
//
// cf-knex's tidb-http adapter *is* @tidbcloud/serverless underneath, so this
// is not a race between two ways of reaching TiDB — it is a measurement of the
// overhead one layer adds to the other. Both sides send byte-identical SQL:
// every statement below is taken from knex's own `.toSQL()` output and handed
// verbatim to the raw driver, so a difference in the numbers cannot be a
// difference in the query.
//
// Run: pnpm bench:tidb  (needs TIDB_URL; reads .env via --env-file)
// Flags: --iterations=N (default 25), --json
//
// Deliberately gentle: sequential, never concurrent, and the whole run is a
// few hundred tiny statements against one temporary table it drops afterwards.
// A TiDB Cloud Serverless free cluster bills request units; keep it that way.
import { connect } from '@tidbcloud/serverless'
import { createClient } from '../dist/tidb.js'

const url = process.env.TIDB_URL
if (!url) {
  console.error('TIDB_URL is not set. Copy .env.example to .env and fill it in.')
  process.exit(1)
}

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? Number(hit.slice(name.length + 3)) : fallback
}
const ITERATIONS = arg('iterations', 25)
const WARMUP = arg('warmup', 3)
const AS_JSON = process.argv.includes('--json')

const table = `cf_knex_bench_${Math.random().toString(36).slice(2, 10)}`
const db = createClient({ url })
const conn = connect({ url })

// Interleaved A/B rather than all-of-A then all-of-B. These are round trips
// over the public internet to a hosted cluster; latency drifts over the life
// of a run, and running the two sides back to back inside each iteration is
// what stops that drift from landing entirely on whichever side went second.
async function measure(name, raw, knex) {
  const rawMs = []
  const knexMs = []
  for (let i = 0; i < WARMUP + ITERATIONS; i++) {
    let t = performance.now()
    await raw()
    const r = performance.now() - t
    t = performance.now()
    await knex()
    const k = performance.now() - t
    if (i >= WARMUP) {
      rawMs.push(r)
      knexMs.push(k)
    }
  }
  return { name, raw: summarize(rawMs), knex: summarize(knexMs) }
}

function summarize(xs) {
  const s = [...xs].sort((a, b) => a - b)
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))]
  return { median: at(0.5), p95: at(0.95), min: s[0], n: s.length }
}

// Pure CPU: how long does the query builder itself take, with no database in
// the picture? This is the part of the overhead that does not disappear into
// network noise, and it costs the cluster nothing to measure.
function buildOverhead() {
  const N = 20_000
  let t = performance.now()
  for (let i = 0; i < N; i++) db(table).where('id', i).select('id', 'name').toSQL()
  const knexUs = ((performance.now() - t) / N) * 1000
  t = performance.now()
  for (let i = 0; i < N; i++) void `select \`id\`, \`name\` from \`${table}\` where \`id\` = ${i}`
  const rawUs = ((performance.now() - t) / N) * 1000
  return { knexUs, rawUs }
}

const sqlOf = (builder) => {
  const { sql, bindings } = builder.toSQL().toNative()
  return [sql, bindings]
}

try {
  await db.schema.dropTableIfExists(table)
  await db.schema.createTable(table, (t) => {
    t.increments('id')
    t.string('name')
  })
  await db(table).insert(Array.from({ length: 20 }, (_, i) => ({ name: `row-${i}` })))
  const seed = await db(table).select('id').first()

  // Every pair below derives its SQL from knex, so both sides send the same bytes.
  const [pointSql, pointBind] = sqlOf(db(table).where('id', seed.id).select('id', 'name'))
  const [listSql, listBind] = sqlOf(db(table).select('id', 'name').orderBy('id').limit(20))
  const [insertSql, insertBind] = sqlOf(db(table).insert({ name: 'bench' }))

  const results = []
  results.push(
    await measure(
      'SELECT 1 (round-trip floor)',
      () => conn.execute('select 1'),
      () => db.raw('select 1'),
    ),
  )
  results.push(
    await measure(
      'point select by primary key',
      () => conn.execute(pointSql, pointBind),
      () => db(table).where('id', seed.id).select('id', 'name'),
    ),
  )
  results.push(
    await measure(
      'select 20 rows',
      () => conn.execute(listSql, listBind),
      () => db(table).select('id', 'name').orderBy('id').limit(20),
    ),
  )
  results.push(
    await measure(
      'single-row insert',
      () => conn.execute(insertSql, insertBind, { fullResult: true }),
      () => db(table).insert({ name: 'bench' }),
    ),
  )
  results.push(
    await measure(
      'transaction: begin, insert, commit',
      async () => {
        const tx = await conn.begin()
        try {
          await tx.execute(insertSql, insertBind, { fullResult: true })
          await tx.commit()
        } catch (err) {
          await tx.rollback()
          throw err
        }
      },
      () => db.transaction((trx) => trx(table).insert({ name: 'bench' })),
    ),
  )

  const build = buildOverhead()
  if (AS_JSON) {
    console.log(JSON.stringify({ iterations: ITERATIONS, results, build }, null, 2))
  } else {
    const f = (n) => `${n.toFixed(1)} ms`
    console.log(`\ncf-knex vs @tidbcloud/serverless — ${ITERATIONS} iterations, interleaved\n`)
    console.log('| Operation | @tidbcloud/serverless | cf-knex | difference |')
    console.log('|---|---|---|---|')
    for (const r of results) {
      const d = r.knex.median - r.raw.median
      const pct = (d / r.raw.median) * 100
      console.log(
        `| ${r.name} | ${f(r.raw.median)} | ${f(r.knex.median)} | ${d >= 0 ? '+' : ''}${d.toFixed(1)} ms (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%) |`,
      )
    }
    console.log('\np95:')
    for (const r of results) console.log(`  ${r.name}: raw ${f(r.raw.p95)}, cf-knex ${f(r.knex.p95)}`)
    console.log(
      `\nquery building only, no network: cf-knex ${build.knexUs.toFixed(1)} µs/query vs ${build.rawUs.toFixed(3)} µs for a template string`,
    )
  }
} finally {
  await db.schema.dropTableIfExists(table).catch(() => {})
  await db.destroy().catch(() => {})
}
