import { createClient } from 'cf-knex/turso'
import type { Knex } from 'knex'

type Env = {
  TURSO_URL: string
  TURSO_AUTH_TOKEN: string
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const db = createClient({
      url: env.TURSO_URL,
      authToken: env.TURSO_AUTH_TOKEN,
      // `intMode` is optional. libsql returns SQLite INTEGERs as JS numbers by
      // default, which silently loses precision above 2^53. Set 'bigint' if a
      // column can exceed that; leave it unset for ordinary ids.
      // intMode: 'bigint',
    })

    // No teardown call: after ordinary queries there is nothing left to close
    // on any backend. See the Lifetime section of ../../README.md for the
    // per-backend measurements, and for what *does* need finishing — an
    // unbalanced transaction. `db.destroy()` still exists, and
    // `await using db = createClient(...)` calls it for you.

    if (req.method === 'POST') {
      // Turso is SQLite, so `insert()` resolves to the inserted rowid.
      const [id] = await db('posts').insert({ title: 'hello from a Worker' })
      return Response.json({ id }, { status: 201 })
    }

    // Unlike D1, libsql has real interactive transactions.
    const posts = await db.transaction(async (trx: Knex.Transaction) => {
      await trx('visits').increment('count', 1).where('page', 'posts')
      return trx('posts').select('id', 'title').orderBy('id', 'desc').limit(10)
    })

    return Response.json(posts)
  },
}
