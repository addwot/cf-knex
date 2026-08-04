import type { Dialect, RawResult } from './types'

export function toKnexResponse(
  dialect: Dialect,
  raw: RawResult,
  obj: Record<string, unknown>,
): Record<string, unknown> {
  if (dialect === 'mysql') {
    const rows = raw.rows as unknown[] & { insertId?: number; affectedRows?: number }
    rows.insertId = Number(raw.insertId ?? 0)
    rows.affectedRows = raw.affectedRows ?? 0
    return { ...obj, response: [rows, raw.fields ?? []] }
  }

  if (dialect === 'postgres') {
    return {
      ...obj,
      response: {
        command: raw.command ?? 'SELECT',
        rows: raw.rows,
        rowCount: raw.affectedRows ?? raw.rows.length,
        fields: raw.fields ?? [],
      },
    }
  }

  return {
    ...obj,
    response: raw.rows,
    context: { lastID: Number(raw.insertId ?? 0), changes: raw.affectedRows ?? 0 },
  }
}
