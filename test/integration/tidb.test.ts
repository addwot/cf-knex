import type { Knex as KnexType } from 'knex'
import { expect, test } from 'vitest'
import { createTidbHttpAdapter } from '../../src/adapters/tidb-http'
import { createKnexClient } from '../../src/core/client'
import { runConformanceSuite } from '../support/conformance'

// Same placeholder-instead-of-silence rule as test/integration/mysql2.test.ts:
// a missing URL must read as "not run here", never as a pass and never as a
// failure, and the file must still register a suite either way.
function skip(name: string, envVar: string) {
  test.skip(`${name} (${envVar} not set)`, () => {})
}

if (process.env.TIDB_URL) {
  const url = process.env.TIDB_URL

  runConformanceSuite('tidb-http (TiDB Cloud Serverless)', () => createKnexClient(createTidbHttpAdapter({ url })), {
    streaming: false,
    transactions: true,
  })

  // TiDB's HTTP response carries `lastInsertId` as a decimal *string*, which
  // this adapter widens to a bigint — where mysql2 over TCP hands back a
  // number for the same insert. The divergence is real and user-visible, so
  // it is pinned here rather than left to be discovered downstream.
  test('insertId comes back as a bigint, where mysql2 gives a number', async () => {
    const db = createKnexClient(createTidbHttpAdapter({ url }))
    const table = `cf_knex_${Math.random().toString(36).slice(2, 10)}`
    try {
      await db.schema.createTable(table, (t) => {
        t.increments('id')
        t.string('name')
      })
      const [id] = await db(table).insert({ name: 'a' })
      expect(typeof id).toBe('bigint')
    } finally {
      await db.schema.dropTableIfExists(table)
      await db.destroy()
    }
  })

  test('a nested transaction rolls back independently of its parent (savepoint path)', async () => {
    const db = createKnexClient(createTidbHttpAdapter({ url }))
    const table = `cf_knex_${Math.random().toString(36).slice(2, 10)}`
    try {
      await db.schema.createTable(table, (t) => {
        t.increments('id')
        t.string('name')
      })

      await db.transaction(async (trx) => {
        await trx(table).insert({ name: 'nest-outer' })
        await expect(
          trx.transaction(async (trx2) => {
            await trx2(table).insert({ name: 'nest-inner' })
            throw new Error('nested rollback')
          }),
        ).rejects.toThrow('nested rollback')
      })

      expect(await db(table).where('name', 'nest-outer').first()).toBeTruthy()
      expect(await db(table).where('name', 'nest-inner').first()).toBeFalsy()
    } finally {
      await db.schema.dropTableIfExists(table)
      await db.destroy()
    }
  })

  // Regression test: before `execute()` learned
  // to intercept BEGIN, `db.raw('BEGIN')` ran as an ordinary statement on
  // the handle knex already held, permanently poisoning it — every later
  // query on that same handle failed with "Transaction connection not
  // found, invalid session or the transaction has been closed/cleaned", and
  // with no `validate()`, the pool kept handing that dead handle back out.
  // `pool: { max: 1 }` forces every acquire below onto the exact same
  // handle, so this deterministically exercises the poisoned-handle path
  // rather than happening to land on a fresh one.
  test('db.raw(BEGIN) followed by ordinary queries does not poison the connection (regression)', async () => {
    const db = createKnexClient(createTidbHttpAdapter({ url }), { pool: { min: 0, max: 1 } })
    const table = `cf_knex_${Math.random().toString(36).slice(2, 10)}`
    try {
      await db.schema.createTable(table, (t) => {
        t.increments('id')
        t.string('name')
      })

      await db.raw('BEGIN')
      await db(table).insert({ name: 'raw-begin' })
      await db.raw('COMMIT')

      expect(await db(table).where('name', 'raw-begin').first()).toBeTruthy()
      // A later, ordinary query on the same (single-connection) pool must
      // still work — this is the assertion the original bug failed.
      expect(await db(table).count('* as count').first()).toBeTruthy()
    } finally {
      await db.schema.dropTableIfExists(table)
      await db.destroy()
    }
  })

  // Joins are the first query shape where a row is assembled from more than
  // one table, so they are where the adapter's row mapping stops being a
  // pass-through. Everything below was checked against a live TiDB Cloud
  // Serverless cluster and, where the two can disagree, against mysql2 over
  // TCP as well.
  //
  // `authors` and `posts` deliberately share both an `id` and a `name`
  // column, because a colliding name is the case that goes wrong quietly.
  // knex's own type, not `ReturnType<typeof createKnexClient>`: `joined()` below
  // is handed a transactor as well as the client, and a transactor is a plain
  // knex object with no `Symbol.asyncDispose` of its own until `transaction()`
  // attaches one.
  type Db = KnexType

  // `aliceId` and `postId` are handed to the callback rather than assumed to
  // be 1 and 1: TiDB allocates auto-increment values from per-node cached
  // ranges, so a fresh table's first id is not guaranteed to be 1 and the
  // guarantee weakens further on a multi-node serverless cluster. Asserting
  // the literal would pass locally and flake in CI.
  async function withJoinTables(
    fn: (db: Db, authors: string, posts: string, ids: { aliceId: number; postId: number }) => Promise<void>,
  ) {
    const db = createKnexClient(createTidbHttpAdapter({ url }))
    const authors = `cf_knex_a_${Math.random().toString(36).slice(2, 8)}`
    const posts = `cf_knex_p_${Math.random().toString(36).slice(2, 8)}`
    try {
      await db.schema.createTable(authors, (t) => {
        t.increments('id')
        t.string('name')
      })
      await db.schema.createTable(posts, (t) => {
        t.increments('id')
        t.integer('author_id')
        t.string('name')
      })
      const [aliceId] = await db(authors).insert({ name: 'alice' })
      // Deliberately childless: the row that proves a LEFT JOIN keeps the
      // left side and an INNER JOIN drops it.
      await db(authors).insert({ name: 'bob' })
      const [postId] = await db(posts).insert({ author_id: Number(aliceId), name: 'alice-post' })
      await fn(db, authors, posts, { aliceId: Number(aliceId), postId: Number(postId) })
    } finally {
      await db.schema.dropTableIfExists(posts)
      await db.schema.dropTableIfExists(authors)
      await db.destroy()
    }
  }

  test('an inner join returns aliased columns from both tables, and drops unmatched left rows', async () => {
    await withJoinTables(async (db, authors, posts, { aliceId }) => {
      const rows = await db(authors)
        .join(posts, `${authors}.id`, `${posts}.author_id`)
        .select(`${authors}.id as author_id`, `${authors}.name as author`, `${posts}.name as post`)
      // Exactly one row: bob has no post, so an inner join must drop him.
      expect(rows).toEqual([{ author_id: aliceId, author: 'alice', post: 'alice-post' }])
    })
  })

  test('a left join yields null — not undefined or a missing key — for an unmatched row', async () => {
    await withJoinTables(async (db, authors, posts) => {
      const rows = await db(authors)
        .leftJoin(posts, `${authors}.id`, `${posts}.author_id`)
        .select(`${authors}.name as author`, `${posts}.name as post`)
        .orderBy('author')
      expect(rows).toEqual([
        { author: 'alice', post: 'alice-post' },
        { author: 'bob', post: null },
      ])
      // `null` and a dropped key are indistinguishable to `row.post` but not
      // to callers doing `'post' in row`, so pin which one arrives.
      expect(Object.keys(rows[1] as object)).toContain('post')
    })
  })

  // Not a TiDB quirk — mysql2 over TCP produces the identical row — but a
  // silent one: `id` and `name` below are the *posts* values, and the
  // authors' are simply gone, with no error and no warning. Pinned so that a
  // future change to the row mapping cannot quietly alter which side wins.
  test('select(*) across a join collapses duplicate column names, last table winning', async () => {
    await withJoinTables(async (db, authors, posts, { aliceId, postId }) => {
      const rows = await db(authors).join(posts, `${authors}.id`, `${posts}.author_id`).select('*')
      // `id` is the post's, not the author's, and `name` is 'alice-post', not
      // 'alice' — the author's two columns are unreachable from this row.
      expect(rows).toEqual([{ id: postId, name: 'alice-post', author_id: aliceId }])
      expect(Object.keys(rows[0] as object)).toEqual(['id', 'name', 'author_id'])
    })
  })

  test('a join inside a transaction sees that transaction uncommitted rows, and loses them on rollback', async () => {
    await withJoinTables(async (db, authors, posts) => {
      const joined = (q: Db) =>
        q(authors)
          .join(posts, `${authors}.id`, `${posts}.author_id`)
          .select(`${authors}.name as author`, `${posts}.name as post`)
          .orderBy('post')

      await expect(
        db.transaction(async (trx) => {
          const [carolId] = await trx(authors).insert({ name: 'carol' })
          await trx(posts).insert({ author_id: Number(carolId), name: 'carol-post' })
          // The join must run inside the transaction's own snapshot: a
          // statement that escaped it would not see carol at all.
          expect(await joined(trx)).toEqual([
            { author: 'alice', post: 'alice-post' },
            { author: 'carol', post: 'carol-post' },
          ])
          throw new Error('rollback')
        }),
      ).rejects.toThrow('rollback')

      expect(await joined(db)).toEqual([{ author: 'alice', post: 'alice-post' }])
    })
  })

  test('a grouped count over a left join counts zero for a row with no match', async () => {
    await withJoinTables(async (db, authors, posts) => {
      const rows = (await db(authors)
        .leftJoin(posts, `${authors}.id`, `${posts}.author_id`)
        .select(`${authors}.name as author`)
        .count(`${posts}.id as posts`)
        .groupBy(`${authors}.name`)
        .orderBy('author')) as Array<{ author: string; posts: unknown }>
      expect(rows.map((r) => [r.author, Number(r.posts)])).toEqual([
        ['alice', 1],
        ['bob', 0],
      ])
    })
  })

  // The count above needs `Number()` because TiDB's HTTP driver hands back
  // COUNT as a decimal *string* where mysql2 over TCP gives a number —
  // verified live against both. Same class of divergence as `insertId`
  // above, and just as invisible until a caller does arithmetic on it, so it
  // gets its own assertion rather than living implicitly inside a coercion.
  test('COUNT comes back as a decimal string, where mysql2 gives a number', async () => {
    const db = createKnexClient(createTidbHttpAdapter({ url }))
    const table = `cf_knex_${Math.random().toString(36).slice(2, 10)}`
    try {
      await db.schema.createTable(table, (t) => {
        t.increments('id')
        t.string('name')
      })
      await db(table).insert({ name: 'a' })
      const row = (await db(table).count('* as count').first()) as { count: unknown }
      expect(typeof row.count).toBe('string')
      expect(row.count).toBe('1')
    } finally {
      await db.schema.dropTableIfExists(table)
      await db.destroy()
    }
  })

  test('an unsupported isolation level throws rather than being silently ignored', async () => {
    const db = createKnexClient(createTidbHttpAdapter({ url }))
    try {
      await expect(db.transaction(async () => {}, { isolationLevel: 'serializable' })).rejects.toMatchObject({
        code: 'UNSUPPORTED_TRANSACTION_MODE',
      })
    } finally {
      await db.destroy()
    }
  })

  test('SET TRANSACTION READ ONLY throws rather than being silently ignored', async () => {
    const db = createKnexClient(createTidbHttpAdapter({ url }))
    try {
      await expect(db.transaction(async () => {}, { readOnly: true })).rejects.toMatchObject({
        code: 'UNSUPPORTED_TRANSACTION_MODE',
      })
      // Pins the wording, not just the code: falling through to the generic
      // unsupported-isolation-level branch instead of the dedicated
      // READ-ONLY one would still throw the same code with different text.
      await expect(db.transaction(async () => {}, { readOnly: true })).rejects.toThrow(/no equivalent/i)
    } finally {
      await db.destroy()
    }
  })
} else {
  skip('tidb-http (TiDB Cloud Serverless)', 'TIDB_URL')
}
