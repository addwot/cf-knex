import { CfKnexError } from './errors'
import type { Dialect, RawResult } from './types'

/**
 * Translates a driver-agnostic RawResult into the exact shape each of knex's
 * three response contracts (mysql2, pg, sqlite3) expects from a driver. This
 * is the single place those three contracts live — four hand-copied shims in
 * other repos each got one of them wrong for lack of exactly this. Pure
 * function: no database, no knex import.
 */
export function toKnexResponse(
  dialect: Dialect,
  raw: RawResult,
  obj: Record<string, unknown>,
): Record<string, unknown> {
  if (dialect === 'mysql') {
    // lib/dialects/mysql/index.js:202-225 — knex's mysql2 dialect destructures
    // `[rows, fields]` from the response and reads `rows.insertId` /
    // `rows.affectedRows` — extra properties attached to the rows array itself,
    // not a wrapper object. Copy `raw.rows` first: it is caller-owned and this
    // function is documented pure, so mutating it in place (and throwing if the
    // caller ever hands us a frozen array) is not acceptable. Attach the two
    // properties non-enumerably so they never leak into `Object.keys` /
    // `for...in` / `toEqual` on an ordinary SELECT result — knex reads the
    // property value, not its descriptor, so behavior is unchanged.
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
    // lib/dialects/postgres/index.js:288-310 — processResponse tests
    // `resp.command === 'SELECT'` first and only reaches the UPDATE|DELETE ->
    // rowCount branch if that test fails. Defaulting a missing `command` to
    // 'SELECT' would silently misroute any DELETE/UPDATE whose adapter forgot
    // to set it, reporting `[]` instead of the affected-row count — the exact
    // signature of the lost-write-metadata bug this file guards against. `pg` always populates `command` on a real `Result`, so
    // a missing one is an adapter bug: fail loudly at the source instead of
    // returning silently wrong data.
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

  // lib/dialects/sqlite3/index.js:192-226 — knex's sqlite3 dialect reads
  // `context.lastID` / `context.changes` for write statements and returns
  // `response` (the bare rows array) for reads. `insertId` is left as
  // `number | bigint` — no `Number()` — because TiDB AUTO_RANDOM, 64-bit
  // auto-increment, and libsql's bigint `lastInsertRowid` all exceed 2^53 and
  // would be silently corrupted by a float conversion.
  if (dialect !== 'sqlite') {
    // Exhaustiveness guard: if `Dialect` ever grows a fourth member, this
    // fails to compile instead of silently falling through to the sqlite
    // branch below.
    const _exhaustive: never = dialect
    throw CfKnexError.malformedResult(`unknown dialect: ${String(_exhaustive)}`)
  }

  return {
    ...obj,
    response: raw.rows,
    context: { lastID: raw.insertId ?? 0, changes: raw.affectedRows ?? 0 },
  }
}
