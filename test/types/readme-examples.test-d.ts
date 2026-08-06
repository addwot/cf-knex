import { expectTypeOf, test } from 'vitest'
import { createClient as createD1Client } from '../../src/entries/d1'
import { createClient as createMysqlClient } from '../../src/entries/mysql'
import { createClient as createPgClient } from '../../src/entries/postgres'
import { createClient as createTidbClient } from '../../src/entries/tidb'
import { createClient as createTursoClient } from '../../src/entries/turso'
import { createClient, fromEnv } from '../../src/index'
import type { Knex } from 'knex'

// Every example in README.md, reduced to the part a compiler can check. A
// README example that doesn't type-check is a defect the rest of the suite
// can't see: nothing else in this project consumes the public API the way a
// reader copying a snippet does. Keep these in step with the README —
// including the imports, which are what prove each entry point exports
// `createClient` under the name the README uses.
//
// This project's `types` project also executes the file as plain JS, so each
// body stays inside an uncalled closure: `createClient` builds a real knex
// instance and a query builder is a thenable that would try to connect.
const d1Binding = { prepare: () => ({}) } as unknown as D1Database
const hyperdrive = {} as Hyperdrive

test('README: D1', () => {
  void (() => {
    const db = createD1Client({ binding: d1Binding })
    expectTypeOf(db).toMatchTypeOf<Knex>()
    return db('posts').orderBy('id', 'desc').limit(10)
  })
})

test('README: Turso, including the intMode escape hatch', () => {
  void (() => {
    const db = createTursoClient({ url: 'libsql://example', authToken: 'token' })
    const large = createTursoClient({ url: 'libsql://example', authToken: 'token', intMode: 'bigint' })
    expectTypeOf(large).toMatchTypeOf<Knex>()
    return db('posts').insert({ title: 'hello' })
  })
})

test('README: Postgres through Hyperdrive, id via .returning()', () => {
  void (() => {
    const db = createPgClient({ hyperdrive })
    return db('posts').insert({ title: 'hello' }).returning('id')
  })
})

test('README: MySQL through Hyperdrive, transaction', () => {
  void (() => {
    const db = createMysqlClient({ hyperdrive })
    return db.transaction(async (trx) => {
      await trx('accounts').where('id', 1).decrement('balance', 100)
      await trx('accounts').where('id', 2).increment('balance', 100)
    })
  })
})

test('README: TiDB Serverless over HTTP', () => {
  void (() => {
    const db = createTidbClient({ url: 'https://example.tidbcloud.com' })
    return db('posts').count('* as n').first()
  })
})

test('README: root entry with engine, and the credentials form', () => {
  void (() => {
    const viaEngine = createClient({ engine: 'postgres', hyperdrive })
    expectTypeOf(viaEngine).toMatchTypeOf<Knex>()
    return createClient({
      engine: 'mysql',
      connection: { host: 'h', port: 3306, user: 'u', password: 'p', database: 'd', ssl: true },
    })
  })
})

test('README: fromEnv', () => {
  void (() => {
    const db = fromEnv({ DB: d1Binding } as unknown as Record<string, unknown>)
    expectTypeOf(db).toMatchTypeOf<Knex>()
    return db('posts').select('*')
  })
})

test('README: pool override through the knex option', () => {
  void (() => createD1Client({ binding: d1Binding, knex: { pool: { min: 0, max: 2 } } }))
})
