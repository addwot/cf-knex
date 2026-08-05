import { env } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { createClient, fromEnv } from '../../src/index'

test('builds a client from a d1 binding', async () => {
  const db = createClient({ engine: 'sqlite', binding: env.DB })
  expect(await db.raw('select 1 as one')).toBeTruthy()
  await db.destroy()
})

test('rejects ambiguous connections', () => {
  expect(() => createClient({ engine: 'mysql', url: 'mysql://h/d', hyperdrive: env.HYPERDRIVE_MYSQL as never })).toThrowError(
    /ambiguous connection/,
  )
})

test('fromEnv builds a client from the one D1 binding it finds among unrelated env values', async () => {
  const db = fromEnv({ DB: env.DB, SOME_STRING: 'not a binding' })
  expect(await db.raw('select 1 as one')).toBeTruthy()
  await db.destroy()
})

test('fromEnv throws and lists candidates when two match', () => {
  expect(() => fromEnv({ DB: env.DB, HYPERDRIVE: env.HYPERDRIVE_MYSQL })).toThrowError(/ambiguous|prefer/i)
})

test('fromEnv throws when nothing matches', () => {
  expect(() => fromEnv({ SOME_STRING: 'x', SOME_NUMBER: 1 })).toThrowError(/no D1 or Hyperdrive binding/)
})

test('fromEnv resolves an ambiguous env with an explicit prefer', async () => {
  const db = fromEnv({ DB: env.DB, HYPERDRIVE: env.HYPERDRIVE_MYSQL }, { prefer: 'd1' })
  expect(await db.raw('select 1 as one')).toBeTruthy()
  await db.destroy()
})
