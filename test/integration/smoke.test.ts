import { expect, test } from 'vitest'

test('the node project can import mysql2, which the workers pool cannot', async () => {
  const mysql = await import('mysql2/promise')
  expect(typeof mysql.createConnection).toBe('function')
})

test('the node project can import pg, which the workers pool cannot', async () => {
  const pg = await import('pg')
  expect(typeof pg.default.Client).toBe('function')
})
