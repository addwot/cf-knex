import { env } from 'cloudflare:test'
import { expect, test } from 'vitest'

test('runs inside workerd with bindings available', () => {
  expect(typeof caches).toBe('object')          // workerd global, absent in Node
  expect(env.DB).toBeDefined()                   // D1 binding
  expect(env.HYPERDRIVE_MYSQL.host).toBeTruthy() // Hyperdrive binding (MySQL)
  expect(env.HYPERDRIVE_PG.host).toBeTruthy()    // Hyperdrive binding (Postgres)
})
