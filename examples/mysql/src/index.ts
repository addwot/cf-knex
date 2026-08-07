import { createClient } from 'cf-knex/mysql'

type Env = {
  MYSQL_URL: string
  HYPERDRIVE: Hyperdrive
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // Two ways to connect. Swap the commented line for Hyperdrive, which pools
    // connections at the edge and caches the TLS handshake — worth it for any
    // real traffic. Nothing else in this file changes.
    const db = createClient({ url: env.MYSQL_URL })
    // const db = createClient({ hyperdrive: env.HYPERDRIVE })

    // No teardown call: after ordinary queries there is nothing left to close
    // on any backend. See the Lifetime section of ../../README.md for the
    // per-backend measurements, and for what *does* need finishing — an
    // unbalanced transaction. `db.destroy()` still exists, and
    // `await using db = createClient(...)` calls it for you.

    if (req.method === 'POST') {
      // MySQL reports the auto-increment value, so `insert()` resolves to it
      // directly — no `.returning()` needed, unlike Postgres.
      const [id] = await db('posts').insert({ title: 'hello from a Worker' })
      return Response.json({ id }, { status: 201 })
    }

    const posts = await db('posts').select('id', 'title').orderBy('id', 'desc').limit(10)
    return Response.json(posts)
  },
}
