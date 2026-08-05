import { expectTypeOf, test } from 'vitest'
import type { Knex } from 'knex'
import { createClient } from '../../src/index'

type MyDb = { users: { id: number; name: string } }

// Minimal valid D1 binding shape (see isD1Binding, src/core/infer.ts).
const fakeD1Binding = { prepare: () => ({}) }

test('createClient forwards its generics to a real Knex', () => {
  const db = createClient<MyDb>({ engine: 'sqlite', binding: fakeD1Binding })
  expectTypeOf(db).toMatchTypeOf<Knex<MyDb>>()
})

test('a typo method does not type-check', () => {
  const db = createClient<MyDb>({ engine: 'sqlite', binding: fakeD1Binding })
  // vitest's typecheck mode also runs this body as real JS; the uncalled
  // wrapper keeps tsc's check without invoking the nonexistent .selec.
  void (() => {
    // @ts-expect-error typo must not compile
    db('users').selec('name')
  })
})

// ClientConfig.driver is not statically tied to engine — an invalid
// combination like { engine: 'sqlite', driver: 'mysql2' } type-checks fine
// and is rejected only at runtime, by test/unit/infer.test.ts.
