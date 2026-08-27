import { CfKnexError } from './errors'
import type { Dialect, RawResult } from './types'

export function toKnexResponse(
  dialect: Dialect,
  raw: RawResult,
  obj: Record<string, unknown>,
): Record<string, unknown> {
  if (dialect === 'mysql') {
    const rows = [...raw.rows] as unknown[] & { insertId?: number | bigint; affectedRows?: number }
    Object.defineProperty(rows, 'insertId', {
      value: raw.insertId ?? 0,
      writable: true,
      configurable: true,
      enumerable: false,
    })
    Object.defineProperty(rows, 'affectedRows', {
      value: raw.affectedRows ?? 0,
      writable: true,
      configurable: true,
      enumerable: false,
    })
    return { ...obj, response: [rows, raw.fields ?? []] }
  }

  if (dialect === 'postgres') {
    if (!raw.command) {
      throw CfKnexError.malformedResult(
        "postgres results require 'command' (e.g. 'SELECT', 'INSERT', 'UPDATE', 'DELETE')",
      )
    }
    return {
      ...obj,
      response: {
        command: raw.command,
        rows: raw.rows,
        rowCount: raw.affectedRows ?? raw.rows.length,
        fields: raw.fields ?? [],
      },
    }
  }

  if (dialect !== 'sqlite') {
    const _exhaustive: never = dialect
    throw CfKnexError.malformedResult(`unknown dialect: ${String(_exhaustive)}`)
  }

  return {
    ...obj,
    response: raw.rows,
    context: { lastID: raw.insertId ?? 0, changes: raw.affectedRows ?? 0 },
  }
}
