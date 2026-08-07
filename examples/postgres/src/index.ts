import { createClient } from 'cf-knex/postgres'

type Env = {
  POSTGRES_URL: string
  HYPERDRIVE: Hyperdrive
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // Two ways to connect. Swap the commented line for Hyperdrive, which pools
    // connections at the edge and caches the TLS handshake — that is what makes
    // Postgres from a Worker practical, since otherwise every request pays a
    // full connect. Nothing else in this file changes.
    const db = createClient({ url: env.POSTGRES_URL })
    // const db = createClient({ hyperdrive: env.HYPERDRIVE })

    // No teardown call: after ordinary queries there is nothing left to close
    // on any backend. See the Lifetime section of ../../README.md for the
    // per-backend measurements, and for what *does* need finishing — an
    // unbalanced transaction. `db.destroy()` still exists, and
    // `await using db = createClient(...)` calls it for you.

    if (req.method === 'POST') {
      // Postgres has no `lastInsertId`; ask for the column back explicitly.
      const [row] = await db('posts').insert({ title: 'hello from a Worker' }).returning('id')
      return Response.json(row, { status: 201 })
    }

    const posts = await db('posts').select('id', 'title').orderBy('id', 'desc').limit(10)
    return Response.json(posts)
  },
}
