import { createClient } from 'cf-knex/d1'

type Env = {
  DB: D1Database
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // The binding is the driver — there is no connection string, no password,
    // and no network round trip to establish. `createClient` is cheap; build
    // it per request rather than hoisting it to module scope.
    const db = createClient({ binding: env.DB })

    // No teardown call: after ordinary queries there is nothing left to close
    // on any backend. See the Lifetime section of ../../README.md for the
    // per-backend measurements, and for what *does* need finishing — an
    // unbalanced transaction. `db.destroy()` still exists, and
    // `await using db = createClient(...)` calls it for you.

    if (req.method === 'POST') {
      // D1 is SQLite, so `insert()` resolves to the inserted rowid.
      const [id] = await db('posts').insert({ title: 'hello from a Worker' })
      return Response.json({ id }, { status: 201 })
    }

    const posts = await db('posts').select('id', 'title').orderBy('id', 'desc').limit(10)
    return Response.json(posts)
  },
}
