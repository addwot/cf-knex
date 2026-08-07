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

  // `timeoutMs` is covered against stub fetches in test/unit/tidb-timeout.test.ts,
  // which is where its edge cases belong. These two exist for the one thing a
  // stub cannot show: that wrapping `fetch` still composes with the real
  // driver over real HTTP — gzip, the `TiDB-Session` round trip, and a
  // `Response` the driver actually parses.
  test('a generous timeoutMs leaves an ordinary query untouched', async () => {
    const db = createKnexClient(createTidbHttpAdapter({ url, timeoutMs: 20_000 }))
    try {
      // knex's mysql dialect hands back `[rows, fields]`, and TiDB sends the
      // literal as the string '1' — both measured, not assumed.
      const [rows] = (await db.raw('SELECT 1 AS one')) as [Array<{ one: unknown }>, unknown[]]
      expect(rows[0]?.one).toBe('1')
    } finally {
      await db.destroy()
    }
  })

  test('a timeoutMs shorter than any real round trip aborts with REQUEST_TIMEOUT', async () => {
    // 1ms cannot be beaten by a TLS round trip to a hosted cluster, so this is
    // deterministic without depending on the cluster being slow. It is the
    // live proof of the failure mode that reached CI as an opaque 30s hang:
    // the request is now bounded, and says which budget it exceeded.
    const db = createKnexClient(createTidbHttpAdapter({ url, timeoutMs: 1 }))
    try {
      await expect(db.raw('SELECT 1')).rejects.toMatchObject({
        name: 'CfKnexError',
        code: 'REQUEST_TIMEOUT',
      })
    } finally {
      await db.destroy()
    }
  })
  // --- Behaviours reported against TiDB Cloud Serverless and its drivers ---
  //
  // Everything below traces to a public issue on `tidbcloud/serverless-js` or
  // one of its sibling ORM adapters. They are characterization tests: what the
  // real cluster returns, measured, so a change in TiDB or in the driver shows
  // up here rather than in a caller's data.

  // tidbcloud/serverless-js#61. A transaction is one server-side session, and
  // a session runs one statement at a time; parallel statements there returned
  // `Rollback transaction fail: invalid connection`, and the driver's
  // maintainers closed the issue as won't-fix with "run the transaction
  // serially". knex does not serialise these — the adapter does. This is the
  // live proof of that, against the cluster the issue was filed about.
  test('parallel statements inside one transaction all commit (serverless-js#61)', async () => {
    const db = createKnexClient(createTidbHttpAdapter({ url }))
    const table = `cf_knex_${Math.random().toString(36).slice(2, 10)}`
    try {
      await db.schema.createTable(table, (t) => {
        t.increments('id')
        t.string('name')
      })

      // Eight, not two: the failure this guards against is a race, and two
      // statements can interleave benignly often enough to pass by luck.
      await db.transaction(async (trx) => {
        await Promise.all(Array.from({ length: 8 }, (_, i) => trx(table).insert({ name: `parallel-${i}` })))
      })

      const row = (await db(table).count('* as count').first()) as { count: unknown }
      expect(Number(row.count)).toBe(8)
    } finally {
      await db.schema.dropTableIfExists(table)
      await db.destroy()
    }
  })

  test('a parallel statement that fails still rolls the whole transaction back', async () => {
    const db = createKnexClient(createTidbHttpAdapter({ url }))
    const table = `cf_knex_${Math.random().toString(36).slice(2, 10)}`
    try {
      await db.schema.createTable(table, (t) => {
        t.integer('id').primary()
        t.string('name')
      })

      // Two of these collide on the primary key. Serialising must not turn a
      // failed sibling into a swallowed one, nor wedge the ROLLBACK behind it.
      await expect(
        db.transaction(async (trx) => {
          await Promise.all([
            trx(table).insert({ id: 1, name: 'a' }),
            trx(table).insert({ id: 1, name: 'b' }),
            trx(table).insert({ id: 2, name: 'c' }),
          ])
        }),
      ).rejects.toThrow()

      const row = (await db(table).count('* as count').first()) as { count: unknown }
      expect(Number(row.count)).toBe(0)
    } finally {
      await db.schema.dropTableIfExists(table)
      await db.destroy()
    }
  })

  // tidbcloud/serverless-js#65 and PR #66: `lastInsertId` used to overflow a JS
  // number and is now a decimal string, which this adapter widens to a bigint.
  // AUTO_RANDOM is where that matters — its ids routinely exceed
  // Number.MAX_SAFE_INTEGER, so a lossy round trip through `number` produces an
  // id that looks plausible and matches no row.
  test('an AUTO_RANDOM insert id survives as a bigint and finds its own row (serverless-js#65)', async () => {
    const db = createKnexClient(createTidbHttpAdapter({ url }))
    const table = `cf_knex_${Math.random().toString(36).slice(2, 10)}`
    try {
      await db.raw(`CREATE TABLE ?? (id BIGINT NOT NULL AUTO_RANDOM, name VARCHAR(64), PRIMARY KEY (id))`, [table])
      const [id] = await db(table).insert({ name: 'auto-random' })

      expect(typeof id).toBe('bigint')
      // The precision claim, made concrete: this is the exact value that a
      // number round trip would have rounded away.
      expect((id as unknown as bigint) > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true)

      // The id is only trustworthy if it selects the row it belongs to.
      const found = (await db(table).where('id', String(id)).first()) as { name?: string } | undefined
      expect(found?.name).toBe('auto-random')
    } finally {
      await db.schema.dropTableIfExists(table)
      await db.destroy()
    }
  })

  // tidbcloud/serverless-js#79: a user was alarmed by auto_increment ids near
  // 3,060,033 on a nearly empty table. That is TiDB working as designed —
  // AUTO_ID_CACHE hands each node a block, so ids are unique and ascending
  // per node but neither dense nor globally monotonic. Pinned because the
  // tempting assumption (first insert gets 1) is what breaks downstream.
  test('auto_increment ids are not dense and must not be assumed to start at 1 (serverless-js#79)', async () => {
    const db = createKnexClient(createTidbHttpAdapter({ url }))
    const table = `cf_knex_${Math.random().toString(36).slice(2, 10)}`
    try {
      await db.schema.createTable(table, (t) => {
        t.increments('id')
        t.string('name')
      })
      const [first] = await db(table).insert({ name: 'a' })
      const [second] = await db(table).insert({ name: 'b' })

      // knex types `insert()` as returning `number[]`, which is exactly the
      // assumption this divergence breaks — hence `unknown` rather than a
      // direct cast, and hence the runtime check on the line above.
      expect(typeof first).toBe('bigint')
      expect((second as unknown as bigint) > (first as unknown as bigint)).toBe(true)
    } finally {
      await db.schema.dropTableIfExists(table)
      await db.destroy()
    }
  })

  // tidbcloud/serverless-js PR #52 fixed bigint *parameters*. Reading a big id
  // back is only half the round trip; binding one into a where-clause is the
  // other half, and it is the half a caller reaches for immediately after
  // getting a bigint id out of an insert.
  test('a bigint binding round-trips through a where-clause (serverless-js PR#52)', async () => {
    const db = createKnexClient(createTidbHttpAdapter({ url }))
    const table = `cf_knex_${Math.random().toString(36).slice(2, 10)}`
    try {
      await db.raw(`CREATE TABLE ?? (id BIGINT NOT NULL, name VARCHAR(64), PRIMARY KEY (id))`, [table])
      const big = 9007199254740993n // MAX_SAFE_INTEGER + 2, unrepresentable as a double
      await db(table).insert({ id: String(big), name: 'big' })

      const found = (await db(table).where('id', String(big)).first()) as { id?: unknown } | undefined
      expect(found).toBeTruthy()
      // Pins that the value survived the server round trip exactly, rather
      // than arriving as 9007199254740992.
      expect(String(found?.id)).toBe('9007199254740993')
    } finally {
      await db.schema.dropTableIfExists(table)
      await db.destroy()
    }
  })

  // tidbcloud/prisma-adapter#19 (TINYINT decoded as `[]`), #45 (JSON columns
  // double-parsed), and serverless-js PRs #55 (BLOB/BINARY/BIT → Uint8Array)
  // and #58 (SET/ENUM). Every one of those was a decode bug that reached a
  // user as wrong data rather than an error, which is exactly the class of
  // failure a type assertion catches and a smoke test does not.
  test('column types decode to the documented JS types (prisma-adapter#19/#45, serverless-js PR#55/#58)', async () => {
    const db = createKnexClient(createTidbHttpAdapter({ url }))
    const table = `cf_knex_${Math.random().toString(36).slice(2, 10)}`
    try {
      await db.raw(
        `CREATE TABLE ?? (
          id INT PRIMARY KEY,
          flag TINYINT,
          amount DECIMAL(10,2),
          payload JSON,
          blob_col BLOB,
          bits BIT(8),
          status ENUM('draft','live'),
          tags SET('a','b'),
          note TEXT
        )`,
        [table],
      )
      await db.raw(
        `INSERT INTO ?? (id, flag, amount, payload, blob_col, bits, status, tags, note)
         VALUES (1, 1, 10.50, '{"k":"v"}', 'bytes', b'10101010', 'live', 'a,b', ?)`,
        [table, 'héllo — 世界 🎉'],
      )

      const row = (await db(table).first()) as Record<string, unknown>

      // TINYINT: the prisma-adapter bug decoded this as an empty array.
      expect(row.flag).toBe(1)
      // DECIMAL: a string, like COUNT above — precision is preserved by not
      // becoming a double.
      expect(typeof row.amount).toBe('string')
      // JSON: already parsed by the driver. A caller that calls JSON.parse on
      // it is prisma-adapter#45.
      expect(row.payload).toEqual({ k: 'v' })
      // BLOB/BIT: raw bytes, per PR #55.
      expect(row.blob_col).toBeInstanceOf(Uint8Array)
      expect(row.bits).toBeInstanceOf(Uint8Array)
      // ENUM/SET: plain strings, per PR #58.
      expect(row.status).toBe('live')
      expect(row.tags).toBe('a,b')
      // serverless-js#30: the decoder read UTF-16 code units where the body is
      // UTF-8, mangling anything outside ASCII. Astral-plane emoji included,
      // since those are the surrogate pairs that broke it.
      expect(row.note).toBe('héllo — 世界 🎉')
    } finally {
      await db.schema.dropTableIfExists(table)
      await db.destroy()
    }
  })

  // The driver calls its default mode a "stateless connection", documented as
  // "each query is independent". Measured against a live cluster, that is not
  // what a single `Connection` does: `execute()` sends whichever `TiDB-Session`
  // token it currently holds and then adopts the one the response returns
  // (dist/index.js), so consecutive statements on one handle land on the same
  // server-side session and session state persists between them.
  //
  // Worth pinning in both directions, because the label points the wrong way.
  // knex hands one pooled handle to unrelated queries in turn, so a `SET @var`,
  // a `USE`, or a session-scoped `SET` is visible to whatever query that handle
  // serves next. Neither layer is misbehaving; the surprise is that "stateless"
  // describes the connection's lifecycle, not the session's.
  test('session state persists across statements on one handle, despite the "stateless" label', async () => {
    const db = createKnexClient(createTidbHttpAdapter({ url }), { pool: { min: 0, max: 1 } })
    try {
      await db.raw('SET @cf_knex_probe = 42')
      const [rows] = (await db.raw('SELECT @cf_knex_probe AS v')) as [Array<{ v: unknown }>, unknown[]]
      expect(Number(rows[0]?.v)).toBe(42)
    } finally {
      await db.destroy()
    }
  })

  // Measured, not assumed, and reproduced 5/5 against a live cluster before
  // being written down: every stateless connection for one credential is
  // handed the *same* server-side session. The `TiDB-Session` tokens are
  // byte-identical and all begin `stateless_`, so this is one shared session,
  // not per-connection sessions that happen to look alike.
  //
  // The consequence is the one that matters to a caller: a user-defined
  // variable set through one cf-knex client is readable through a completely
  // separate client — different `createKnexClient`, different pool, different
  // `Connection` object. Session-scoped state on TiDB Cloud Serverless is not
  // scoped to anything cf-knex controls, so it must not be used to carry
  // anything a caller would mind another request seeing.
  test('session state crosses between separate clients, because stateless connections share one session', async () => {
    const first = createKnexClient(createTidbHttpAdapter({ url }), { pool: { min: 0, max: 1 } })
    const second = createKnexClient(createTidbHttpAdapter({ url }), { pool: { min: 0, max: 1 } })
    // A fresh name per run: a fixed one would be set by earlier runs against
    // the same shared session, which would make this pass without proving
    // anything.
    const probe = `cf_knex_${Math.random().toString(36).slice(2, 10)}`
    try {
      // Reachable-null control. Without this the assertion below cannot
      // distinguish a real leak from a cluster that answers 'leaked' to
      // everything.
      const [before] = (await second.raw(`SELECT @${probe} AS v`)) as [Array<{ v: unknown }>, unknown[]]
      expect(before[0]?.v).toBeNull()

      await first.raw(`SET @${probe} = 'leaked'`)
      const [after] = (await second.raw(`SELECT @${probe} AS v`)) as [Array<{ v: unknown }>, unknown[]]
      expect(after[0]?.v).toBe('leaked')
    } finally {
      await first.destroy()
      await second.destroy()
    }
  })

  test('a transaction gets a private session, so its variables do not leak out while it is open', async () => {
    // The counterpart to the leak above, and the property the adapter depends
    // on: `begin()` is issued a `txn_`-prefixed token rather than the shared
    // `stateless_` one. This is what makes a transaction's reads and writes
    // genuinely its own, and what the session-escape detector is checking has
    // not silently stopped being true.
    const db = createKnexClient(createTidbHttpAdapter({ url }))
    const observer = createKnexClient(createTidbHttpAdapter({ url }))
    const probe = `cf_knex_${Math.random().toString(36).slice(2, 10)}`
    try {
      await db.transaction(async (trx) => {
        await trx.raw(`SET @${probe} = 'in-tx'`)
        const [seen] = (await observer.raw(`SELECT @${probe} AS v`)) as [Array<{ v: unknown }>, unknown[]]
        expect(seen[0]?.v).toBeNull()
      })
    } finally {
      await db.destroy()
      await observer.destroy()
    }
  })

  test('session state does survive between statements inside a transaction', async () => {
    // The mirror image, and the reason the adapter routes in-transaction
    // statements through the `Tx` rather than the base connection: a
    // transaction *is* one session, so the variable persists. If this ever
    // fails while the test above passes, statements are escaping the
    // transaction.
    const db = createKnexClient(createTidbHttpAdapter({ url }))
    try {
      const v = await db.transaction(async (trx) => {
        await trx.raw('SET @cf_knex_probe = 42')
        const [rows] = (await trx.raw('SELECT @cf_knex_probe AS v')) as [Array<{ v: unknown }>, unknown[]]
        return rows[0]?.v
      })
      expect(Number(v)).toBe(42)
    } finally {
      await db.destroy()
    }
  })
} else {
  skip('tidb-http (TiDB Cloud Serverless)', 'TIDB_URL')
}
