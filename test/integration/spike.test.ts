// Spike: prove (a) workerd can open an outbound raw TCP connection to a
// database container, and (b) mysql2's streaming API works under workerd.
// Both are open risks (spec §3.5, §5.3) that block later tasks — this file
// is not feature code, it is the measurement. See the recorded decision at
// docs/superpowers/notes/2026-08-04-workerd-spike.md.
//
// No skipIf: a skipped spike produces no decision, and the decision is the
// whole deliverable. If MYSQL_URL is unreachable, these must fail loudly.
//
// MYSQL_URL comes from a miniflare binding (test/env.d.ts, vitest.config.ts),
// not process.env — test bodies run inside workerd, where process.env holds
// only Vite-injected keys, never host environment variables.
import { env } from 'cloudflare:test'
import { createConnection } from 'mysql2/promise'
import { expect, test } from 'vitest'

const url = env.MYSQL_URL

// mysql2's package.json `exports` map has no `types` condition (it relies on
// the legacy promise.d.ts-next-to-promise.js convention), and the promise
// `Connection` class in that file is assembled from generic mixins
// (`QueryableBase<T>(ExecutableBase(EventEmitter))`) whose TS-inferred shape
// does not expose `.query()` under this project's `moduleResolution:
// "bundler"` — a typings gap, not a runtime one (confirmed: `.query()` works
// against a real connection when run in plain Node, see the decision note).
// `.connection` has the same gap: mysql2's .d.ts only declares it on
// `PoolConnection`, though the promise wrapper sets it on every connection at
// runtime (mysql2/lib/promise/connection.js). Cast through a minimal local
// type describing only what this spike calls, instead of fighting the
// upstream mixin inference.
type SpikeConnection = {
  query: (sql: string) => Promise<[unknown, unknown]>
  end: () => Promise<void>
  connection: {
    query: (sql: string) => {
      stream: () => { on: (event: string, listener: (arg: never) => void) => unknown }
    }
  }
}

async function connect(): Promise<SpikeConnection> {
  return (await createConnection({ uri: url, disableEval: true })) as unknown as SpikeConnection
}

test('workerd can open a TCP connection to MySQL', async () => {
  const conn = await connect()
  const [rows] = await conn.query('SELECT 1 AS one')
  expect((rows as Array<{ one: number }>)[0]?.one).toBe(1)
  await conn.end()
})

test('mysql2 streaming works under workerd', async () => {
  const conn = await connect()
  await conn.query('CREATE TEMPORARY TABLE spike (id INT)')
  await conn.query('INSERT INTO spike (id) VALUES (1), (2), (3)')
  const seen: number[] = []
  await new Promise<void>((resolve, reject) => {
    const s = conn.connection.query('SELECT id FROM spike ORDER BY id').stream()
    s.on('data', (r) => seen.push((r as { id: number }).id))
    s.on('end', resolve)
    s.on('error', reject)
  })
  expect(seen).toEqual([1, 2, 3])
  await conn.end()
})
