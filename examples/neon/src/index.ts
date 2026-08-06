import { createClient } from 'cf-knex/postgres'

type Env = {
  // Neon is Postgres, so it uses the `pg` adapter and the `cf-knex/postgres`
  // entry point. There is no separate Neon backend.
  NEON_URL: string
  HYPERDRIVE: Hyperdrive
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // Two ways to connect. Use the pooled Neon endpoint for the URL form; for
    // the Hyperdrive form give Hyperdrive the DIRECT (non-pooler) URL, since it
    // does its own pooling. Nothing else in this file changes.
    const db = createClient({ url: env.NEON_URL })
    // const db = createClient({ hyperdrive: env.HYPERDRIVE })

    try {
      if (req.method === 'POST') {
        const [row] = await db('posts').insert({ title: 'hello from a Worker' }).returning('id')
        return Response.json(row, { status: 201 })
      }

      const posts = await db('posts').select('id', 'title').orderBy('id', 'desc').limit(10)
      return Response.json(posts)
    } finally {
      await db.destroy()
    }
  },
}
