import { createClient } from 'cf-knex/tidb'

type Env = {
  TIDB_URL: string
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // TiDB Cloud Serverless over HTTP: no TCP socket, no connection pool to
    // warm, no Hyperdrive needed. Each statement is an HTTPS request.
    const db = createClient({ url: env.TIDB_URL })

    try {
      if (req.method === 'POST') {
        // Note the type: the HTTP protocol returns `lastInsertId` as a decimal
        // string, which this adapter widens to a bigint. The same insert over
        // the MySQL wire protocol gives a number instead.
        const [id] = await db('posts').insert({ title: 'hello from a Worker' })
        return Response.json({ id: String(id) }, { status: 201 })
      }

      const posts = await db('posts').select('id', 'title').orderBy('id', 'desc').limit(10)
      return Response.json(posts)
    } finally {
      await db.destroy()
    }
  },
}
