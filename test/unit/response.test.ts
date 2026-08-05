import { expect, test } from 'vitest'
import { CfKnexError } from '../../src/core/errors'
import { toKnexResponse } from '../../src/core/response'

const obj = { method: 'select', sql: 'select 1', bindings: [] }

test('preserves every field of the incoming obj', () => {
  const out = toKnexResponse('mysql', { rows: [] }, obj)
  expect(out.method).toBe('select')
  expect(out.sql).toBe('select 1')
})

test('mysql wraps rows and fields in an array', () => {
  const out = toKnexResponse('mysql', { rows: [{ a: 1 }], fields: ['a'] }, obj)
  expect(out.response).toEqual([[{ a: 1 }], ['a']])
})

test('mysql attaches insertId and affectedRows to the rows array', () => {
  const out = toKnexResponse('mysql', { rows: [], insertId: 42, affectedRows: 3 }, obj)
  const rows = (out.response as unknown[])[0] as { insertId: number; affectedRows: number }
  expect(rows.insertId).toBe(42)
  expect(rows.affectedRows).toBe(3)
})

test('postgres builds a pg-shaped result with command set', () => {
  const out = toKnexResponse('postgres', { rows: [{ a: 1 }], command: 'SELECT', affectedRows: 1 }, obj)
  expect(out.response).toEqual({ command: 'SELECT', rows: [{ a: 1 }], rowCount: 1, fields: [] })
})

test('sqlite returns a bare rows array and puts write metadata on context', () => {
  const out = toKnexResponse('sqlite', { rows: [{ a: 1 }], insertId: 7, affectedRows: 2 }, obj)
  expect(out.response).toEqual([{ a: 1 }])
  expect(out.context).toEqual({ lastID: 7, changes: 2 })
})

test('preserves every field of the incoming obj, including non-method keys (postgres)', () => {
  const richObj = { method: 'select', sql: 'select 1', bindings: [], returning: ['id'] }
  const out = toKnexResponse('postgres', { rows: [{ a: 1 }], command: 'SELECT' }, richObj)
  expect(out.method).toBe('select')
  expect(out.sql).toBe('select 1')
  expect(out.returning).toEqual(['id'])
})

test('preserves every field of the incoming obj (sqlite)', () => {
  const out = toKnexResponse('sqlite', { rows: [] }, obj)
  expect(out.method).toBe('select')
  expect(out.sql).toBe('select 1')
})

test('mysql keeps a bigint insertId unchanged (no Number() truncation)', () => {
  const bigId = 9007199254740993n // 2^53 + 1 — unrepresentable as a Number
  const out = toKnexResponse('mysql', { rows: [], insertId: bigId }, obj)
  const rows = (out.response as unknown[])[0] as { insertId: bigint }
  expect(rows.insertId).toBe(bigId)
})

test('sqlite keeps a bigint insertId unchanged (no Number() truncation)', () => {
  const bigId = 9007199254740993n // 2^53 + 1 — unrepresentable as a Number
  const out = toKnexResponse('sqlite', { rows: [], insertId: bigId }, obj)
  expect((out.context as { lastID: bigint }).lastID).toBe(bigId)
})

test('mysql attaches metadata non-enumerably so a SELECT response has no phantom keys', () => {
  const out = toKnexResponse('mysql', { rows: [{ a: 1 }], fields: ['a'] }, obj)
  const [rows] = out.response as [unknown[], unknown[]]
  expect(Object.keys(rows)).toEqual(['0'])
})

test('postgres throws MALFORMED_DRIVER_RESULT when command is missing', () => {
  expect.assertions(2)
  try {
    toKnexResponse('postgres', { rows: [] }, obj)
  } catch (err) {
    expect(err).toBeInstanceOf(CfKnexError)
    expect((err as CfKnexError).code).toBe('MALFORMED_DRIVER_RESULT')
  }
})
