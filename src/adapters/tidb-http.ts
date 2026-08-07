import { CfKnexError } from '../core/errors'
import type { DriverAdapter, RawResult } from '../core/types'
import type { FullResult } from '@tidbcloud/serverless'

type Isolation = 'READ COMMITTED' | 'REPEATABLE READ'

// A local shim for the `Connection`/`Tx` members this adapter calls
// (node_modules/@tidbcloud/serverless/dist/index.d.ts), the same way
// src/adapters/mysql2.ts declares `Mysql2ConnectionShim`, rather than the
// real generic `Connection<T>`/`Tx<T>` types: `execute`'s real signature is
// a conditional type keyed off the literal shape of its `options` argument,
// and always passing `{ fullResult: true }` is what resolves it to
// `FullResult` — the shape carrying `rowsAffected`/`lastInsertId`.
type TidbConnection = {
  execute(query: string, args: unknown[], options: { fullResult: true }): Promise<FullResult>
  begin(txOptions?: { isolation?: Isolation }): Promise<TidbTx>
}

type TidbTx = {
  execute(query: string, args: unknown[], options: { fullResult: true }): Promise<FullResult>
  rollback(): Promise<unknown>
  // Driver internal, read-only and optional on purpose — see `sessionOf()`.
  conn?: { session?: string | null }
}

// The `TiDB-Session` token identifying the server-side session a statement
// runs in. `Connection.execute()` sends whatever it currently holds and then
// overwrites it from the response, unconditionally
// (node_modules/@tidbcloud/serverless/dist/index.js) — so if the server ever
// declines to recognize the token, it runs that statement in autocommit,
// hands back a different session, and the driver silently adopts it. Nothing
// throws, and the statement is now outside the transaction the caller
// believes it is in.
//
// Verified against a live TiDB Cloud Serverless cluster before this was
// relied on: the token is allocated by `BEGIN` and is byte-identical across
// every statement of that transaction, including its terminating
// COMMIT/ROLLBACK, and differs between transactions. It is not rotated per
// response, so a change mid-transaction is never normal.
//
// Optional chaining rather than a hard read: `conn`/`session` are the
// driver's internals, not its public API, and this adapter's peer range
// (`>=0.2.0`) admits versions that may not shape them this way. A driver
// that no longer exposes the token returns `undefined` here, which
// `assertSameSession` treats as "cannot check" and skips — degrading to the
// previous behaviour rather than throwing on every query.
function sessionOf(tx: TidbTx): string | null | undefined {
  return tx.conn?.session
}

export type TidbHttpAdapterOptions = {
  url: string
  /**
   * Aborts any single HTTP request that has not completed within this many
   * milliseconds, raising `CfKnexError` with code `REQUEST_TIMEOUT`.
   *
   * There is no default, and omitting this leaves every request unbounded —
   * which is what the driver does on its own. `postQuery` in
   * node_modules/@tidbcloud/serverless/dist/index.js calls `fetch` with no
   * `signal`, no timeout and no retry, so nothing below this option can stop
   * a request that never comes back. Observed: a statement that normally
   * takes ~1s hung past 30s against a healthy cluster while every other
   * statement in the same run kept its usual timing.
   *
   * A bound is not a free win, which is why it is opt-in: the abort is local,
   * so a statement that times out may still be applied server-side. Choose a
   * budget above the slowest query you actually expect, and treat the error
   * as "unknown outcome", not "did not happen".
   */
  timeoutMs?: number
  /**
   * Replaces the `fetch` handed to the driver — for retries, tracing, or a
   * bound more specific than `timeoutMs`. `timeoutMs` composes on top of it
   * rather than around the global, so the two work together.
   */
  fetch?: typeof fetch
}

/**
 * The `fetch` the driver is given: the caller's, the global, and `timeoutMs`
 * layered over whichever of those applies.
 *
 * Built once per adapter rather than per `acquire()`, and returned unwrapped
 * when no budget is set, so a client that does not ask for a timeout pays
 * nothing and the driver sees the exact function it would have seen before.
 *
 * Exported for tests, not part of the package's public API — the same reason
 * `resolveConfig` is exported from ./pg.ts. Two of the four behaviours below
 * (a caller-supplied `signal`, and a `fetch` that ignores the one it is
 * given) cannot be reached through `createTidbHttpAdapter` while the driver
 * sends no signal of its own, and asserting them directly beats shipping them
 * untested.
 */
export function resolveFetch(opts: TidbHttpAdapterOptions): typeof fetch {
  const base = opts.fetch ?? fetch
  const ms = opts.timeoutMs
  if (ms === undefined) return base
  return async (input, init) => {
    const budget = AbortSignal.timeout(ms)
    // `AbortSignal.any` rather than overwriting: 0.3.0's `postQuery` passes no
    // `signal`, but this adapter's peer range admits versions that might, and
    // dropping a caller's own cancellation would be silent. Both signals are
    // live, so whichever fires first wins.
    const signal = init?.signal ? AbortSignal.any([init.signal, budget]) : budget
    // Raced as well as passed, because passing it alone only bounds a `fetch`
    // that honors signals. The global does; a caller's wrapper is not obliged
    // to, and a `timeoutMs` that silently did nothing there would be the exact
    // unbounded wait this option exists to remove. The signal still goes
    // through so a well-behaved `fetch` is genuinely cancelled rather than
    // merely abandoned — the race is the floor, not the mechanism.
    const expired = new Promise<never>((_, reject) => {
      budget.addEventListener('abort', () => reject(CfKnexError.requestTimedOut('tidb-http', ms)), { once: true })
    })
    try {
      return await Promise.race([base(input, { ...init, signal }), expired])
    } catch (err) {
      // Asks the signal we created rather than matching on the rejection's
      // name or message: what an aborted `fetch` rejects with differs between
      // workerd and Node, and this collapses both orderings — the race winning
      // and the base rejecting on abort first — onto one error. A caller's own
      // `init.signal` aborting leaves `budget.aborted` false, so their
      // cancellation still surfaces as itself.
      if (budget.aborted) throw CfKnexError.requestTimedOut('tidb-http', ms)
      throw err
    }
  }
}

// Per-handle transaction bookkeeping: the open `Tx` once `BEGIN` has run,
// and an isolation level a preceding `SET TRANSACTION` asked for but that
// hasn't reached a `begin()` call yet. A `WeakMap` keyed by handle scopes
// this to each `Connection` `acquire()` hands out — never shared, so no
// cross-handle bleed — and lets an evicted handle's entry be collected.
type TxState = { tx?: TidbTx; session?: string | null; pendingIsolation?: Isolation }

// Throws if `tx` is no longer on the session it was opened with, meaning the
// statement just executed did not run inside the transaction. `expected` is
// the token recorded at BEGIN; `undefined` on either side means the driver
// does not expose it and the check is skipped rather than guessed at.
//
// The tokens themselves never reach the message: they authenticate a live
// server-side session, so they are credentials, and this project's rule is
// that credentials never reach an error or a log (see `redact()` in
// ../core/infer.ts).
function assertSameSession(expected: string | null | undefined, tx: TidbTx, sql: string): void {
  if (expected === undefined || expected === null) return
  const actual = sessionOf(tx)
  if (actual === undefined || actual === expected) return
  throw CfKnexError.transactionEscaped(
    `the TiDB session changed while running ${describeStatement(sql)}, so the server ran it in autocommit rather than in this transaction. This is a TiDB Cloud Serverless HTTP behaviour, not a query error; retry the whole transaction.`,
  )
}

// Statement kinds, not statement text: the SQL knex generates carries table
// and column names, and bound values are already separate, but an inlined
// literal in a raw query would otherwise land in an error message.
function describeStatement(sql: string): string {
  const verb = /^\s*([A-Za-z]+)/.exec(sql)?.[1]?.toUpperCase()
  if (!verb) return 'a statement'
  return `${/^[AEIOU]/.test(verb) ? 'an' : 'a'} ${verb} statement`
}

// A `DriverAdapter` over `@tidbcloud/serverless` 0.3.0's HTTP driver for
// TiDB Cloud Serverless.
//
// `capabilities.streaming` is `false`: `Connection.execute()`
// (dist/index.js's `postQuery`) always `await`s `response.json()` in full —
// the package exposes no cursor or chunked-read API to wrap.
//
// `capabilities.transactions` is `true`. `Connection.begin()` allocates a
// brand-new `Connection` rather than mutating the one it's called on, so
// knex's BEGIN/COMMIT/ROLLBACK — issued as plain SQL through this adapter's
// `execute()`, on the one handle it already holds for the transaction's
// whole lifetime — have nowhere to go without help. `execute()` below
// intercepts those statements (and, once open, forwards everything else,
// including savepoint SQL, straight to that `Tx` unchanged) instead of
// letting them fall through to `Connection.execute()`, which would
// silently run each one on its own throwaway session.
export function createTidbHttpAdapter(opts: TidbHttpAdapterOptions): DriverAdapter {
  const txStates = new WeakMap<TidbConnection, TxState>()
  const request = resolveFetch(opts)

  return {
    dialect: 'mysql',
    driver: 'tidb-http',
    capabilities: { streaming: false, transactions: true },

    async acquire(): Promise<TidbConnection> {
      let serverless: typeof import('@tidbcloud/serverless')
      try {
        serverless = await import('@tidbcloud/serverless')
      } catch {
        throw CfKnexError.missingDriver('@tidbcloud/serverless')
      }
      // A brand-new `Connection` every call, never cached and shared:
      // `db.transaction()` holds whichever handle `acquire()` gives it for
      // the transaction's whole lifetime, so sharing one `Connection`
      // across callers would let an unrelated query land on whatever
      // session state — or open transaction — that instance's
      // `this.session` currently holds. `connect()` is a pure constructor
      // with no I/O (dist/index.js), so this costs nothing extra.
      return serverless.connect({ url: opts.url, fetch: request }) as unknown as TidbConnection
    },

    // A caller who issues `db.raw('BEGIN')` and never commits, or abandons
    // a `db.transaction()` handle outright, can reach here with `state.tx`
    // still set. The rollback's outcome doesn't matter — the transaction is
    // being abandoned either way — but the map entry must still be cleared,
    // even on a throw, so nothing later mistakes this handle for one still
    // mid-transaction.
    async release(handle: unknown): Promise<void> {
      const conn = handle as TidbConnection
      const state = txStates.get(conn)
      txStates.delete(conn)
      if (state?.tx) await state.tx.rollback().catch(() => {})
    },

    async execute(handle, sql, bindings): Promise<RawResult> {
      const conn = handle as TidbConnection
      const state = txStates.get(conn)

      if (state?.tx) {
        const { tx } = state
        if (COMMIT_STATEMENT.test(sql) || ROLLBACK_STATEMENT.test(sql)) {
          try {
            const ended = toRawResult(await tx.execute(sql, bindings, { fullResult: true }))
            // A COMMIT that escaped is the worst case of all: it reports
            // success while the writes it was meant to make durable were
            // already applied (or lost) outside its control.
            assertSameSession(state.session, tx, sql)
            return ended
          } finally {
            // Ends the transaction on this handle regardless of outcome — a
            // failed COMMIT still ends it, and leaving `state.tx` behind
            // would let the next statement on this handle silently keep
            // running "inside" a transaction the caller believes is closed.
            txStates.delete(conn)
          }
        }
        // Savepoint SQL and anything else issued while a transaction is
        // open: forward unchanged to the `Tx`, never to `conn`. Verified
        // live against a real TiDB Cloud Serverless cluster: SAVEPOINT,
        // ROLLBACK TO SAVEPOINT, RELEASE SAVEPOINT, and COMMIT all pass
        // through `tx.execute()` unmodified.
        const result = toRawResult(await tx.execute(sql, bindings, { fullResult: true }))
        try {
          // Checked after every in-transaction statement, not just writes: by
          // the time one has escaped, a SELECT is reading outside the
          // transaction's snapshot too, and the caller has no other signal
          // that it happened.
          assertSameSession(state.session, tx, sql)
        } catch (err) {
          // The transaction this handle believed it held no longer exists on
          // the server. Forgetting it is not bookkeeping tidiness: without
          // this, every later statement on this handle — including the
          // caller's own cleanup, and `release()`'s rollback — is still
          // routed into that dead `Tx`. On a `pool: { max: 1 }` client, where
          // cleanup necessarily reuses this same handle, that turns a
          // detected escape into a hang.
          txStates.delete(conn)
          throw err
        }
        return result
      }

      if (BEGIN_STATEMENT.test(sql)) {
        const isolation = state?.pendingIsolation
        // Consumed before `begin()` is called, not after it resolves: a
        // rejected `begin()` still ends this statement pair, and a level
        // left behind would be applied to whatever transaction opened next
        // on this handle.
        txStates.delete(conn)
        const tx = await conn.begin(isolation ? { isolation } : undefined)
        // Recorded here rather than read fresh on each statement: this is the
        // session BEGIN allocated, and every later statement on this
        // transaction must still be on it.
        txStates.set(conn, { tx, session: sessionOf(tx) })
        return { rows: [] }
      }

      const setTransaction = SET_TRANSACTION_STATEMENT.exec(sql)
      if (setTransaction) {
        txStates.set(conn, { pendingIsolation: parseIsolationLevel(setTransaction[1] ?? '') })
        return { rows: [] }
      }

      // knex emits `SET TRANSACTION ...` as the statement immediately before
      // its `BEGIN`, so a remembered level is only ever meant to survive one
      // statement. Reaching any other statement first means that `BEGIN`
      // never came — the transaction was abandoned, or failed before it was
      // sent — and the handle goes back to the pool. Dropping the level here
      // is what stops it from being silently applied to some later,
      // unrelated transaction that asked for no isolation level at all.
      if (state) txStates.delete(conn)

      const result: unknown = await conn.execute(sql, bindings, { fullResult: true })
      return toRawResult(result)
    },

    // Empty because this adapter keeps no state outliving a handle: `release()`
    // above rolls back and clears whatever transaction that handle held, and
    // `txStates` is a WeakMap keyed by the handle itself, so there is nothing
    // left here to close a second time.
    //
    // Note this does NOT rely on running after the pool's release pass — the
    // `DriverAdapter` contract in ../core/types.ts explicitly does not promise
    // that any more, because `Client.destroy()` bounds how long it waits. A
    // handle still checked out when that budget expires is one this adapter
    // never sees again, and its transaction stays open server-side until TiDB
    // expires it. Nothing reachable from here can close it: the handle is still
    // held by its abandoning caller, and issuing a ROLLBACK on a different
    // handle would land on a different TiDB-Session token entirely.
    async destroy(): Promise<void> {},

    // No `validate()` — omitted entirely, not just set to a function that
    // always returns `true`. An HTTP-backed handle like this one reopens no
    // socket and holds no server-side session between calls, so there is
    // nothing that can go stale while it sits idle in the pool between
    // queries; `createKnexClient` (../core/client.ts) already treats a
    // missing `validate` as "always valid", which is the correct default
    // here, not a stricter check this adapter would otherwise have to
    // reimplement to opt back out of.
  }
}

// `execute()` above always requests `{ fullResult: true }`, so a
// well-formed response is exactly the package's `FullResult` shape
// (dist/index.d.ts): an object with `rows: Row[] | null`, plus nullable
// `rowsAffected`/`lastInsertId`. A JSON envelope crossing an HTTP boundary
// is exactly where a malformed shape becomes reachable — a proxy that
// forgot to honor `fullResult: true`, a truncated response body — so this
// rejects rather than coercing with `(result as any).rows ?? []`, which
// would silently turn any of those into an empty success instead of
// surfacing the failure. Unlike src/adapters/mysql2.ts's `toRawResult`,
// `lastInsertId`/`rowsAffected` get the same treatment as `rows`, not just
// `rows` itself: those values arrive over untrusted HTTP JSON here, not
// through mysql2's own trusted packet parser.
function toRawResult(result: unknown): RawResult {
  // A bare `Row[]` (what the package returns when `fullResult` was *not*
  // honored) is still an object under `typeof`, so `Array.isArray` must be
  // checked separately. `FullResult` always carries a `rows` key (possibly
  // `null`, never omitted), so requiring the key's presence catches an
  // object that merely lacks the field too.
  if (result === null || typeof result !== 'object' || Array.isArray(result) || !('rows' in result)) {
    throw CfKnexError.malformedResult(
      `tidb-http query did not return a fullResult object with a 'rows' field (got ${Array.isArray(result) ? 'an array' : result === null ? 'null' : typeof result})`,
    )
  }
  const rows = (result as { rows: unknown }).rows
  if (!(Array.isArray(rows) || rows === null)) {
    throw CfKnexError.malformedResult(`tidb-http query's 'rows' was neither an array nor null (got ${typeof rows})`)
  }

  const full = result as Partial<FullResult>
  return {
    rows: full.rows ?? [],
    insertId: normalizeInsertId(full.lastInsertId),
    affectedRows: normalizeAffectedRows(full.rowsAffected),
  }
}

// `FullResult.lastInsertId` is `string | null` (dist/index.d.ts), read
// straight off the raw JSON body with no numeric parsing — presumably so
// TiDB's `AUTO_RANDOM`/64-bit ids, which routinely exceed
// `Number.MAX_SAFE_INTEGER`, never round-trip through a lossy JS number
// first. Converting a well-formed digit string straight to `bigint`
// mirrors src/adapters/mysql2.ts's handling of its own numeric-string ids,
// but this one arrives over untrusted JSON, so it's validated before
// `BigInt()` rather than handed to it directly: an unparseable string
// would otherwise throw an opaque `SyntaxError` instead of a typed
// `CfKnexError`, and `BigInt('') === 0n` would otherwise masquerade as a
// real id of `0`. The `number` branch isn't reachable through the real
// package — it only lets a hand-built test mock pass through unwidened.
function normalizeInsertId(id: string | number | null | undefined): bigint | number | undefined {
  if (id === null || id === undefined) return undefined
  if (typeof id === 'number') return id
  if (!/^\d+$/.test(id)) {
    throw CfKnexError.malformedResult(`tidb-http lastInsertId was not a numeric string (got ${JSON.stringify(id)})`)
  }
  return BigInt(id)
}

// `FullResult.rowsAffected` is typed `number | null` and read straight off
// the raw JSON body with no validation. `RawResult.affectedRows` is typed
// `number` and flows straight into knex's `.update()`/`.delete()`
// return-value handling, so a string here (a malformed response, or a
// proxy that re-serialized the field) would pass through silently where
// every caller expects a number.
function normalizeAffectedRows(value: number | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'number') {
    throw CfKnexError.malformedResult(`tidb-http rowsAffected was not a number (got ${typeof value})`)
  }
  return value
}

// Anchored, case-insensitive, tolerant of an optional trailing semicolon
// and whitespace — matching knex's lib/execution/transaction.js output
// verbatim (`BEGIN;`, `COMMIT;`, a bare `ROLLBACK` with none at all).
// `ROLLBACK_STATEMENT` does not match `ROLLBACK TO SAVEPOINT x`, and
// `COMMIT_STATEMENT` does not match `RELEASE SAVEPOINT x;` — both are
// nested-transaction statements that must reach the open `Tx` unchanged,
// not end it.
const BEGIN_STATEMENT = /^(?:BEGIN|START\s+TRANSACTION)\s*;?\s*$/i
const COMMIT_STATEMENT = /^COMMIT\s*;?\s*$/i
const ROLLBACK_STATEMENT = /^ROLLBACK\s*;?\s*$/i
const SET_TRANSACTION_STATEMENT = /^SET\s+TRANSACTION\s+(.+?)\s*;?\s*$/i

// `mode` is whatever knex put after `SET TRANSACTION` (`ISOLATION LEVEL
// read committed`, `READ ONLY`, or — if a caller set both — the two joined
// with a space; see knex's lib/execution/transaction.js `begin()`).
// `TxOptions.isolation` accepts exactly `'READ COMMITTED' | 'REPEATABLE
// READ'`; the driver has no read-only option at all. Throwing here rather
// than dropping either silently means a caller learns their request wasn't
// honored, instead of discovering it as a transaction that behaved
// differently than asked.
function parseIsolationLevel(mode: string): Isolation {
  if (/READ\s+ONLY/i.test(mode)) {
    throw CfKnexError.unsupportedTransactionMode(
      "'SET TRANSACTION READ ONLY' has no equivalent in the tidb-http driver — the transaction that follows would silently open read/write instead of read-only.",
    )
  }
  const level = mode.replace(/^ISOLATION\s+LEVEL\s+/i, '').trim().toUpperCase().replace(/\s+/g, ' ')
  if (level === 'READ COMMITTED' || level === 'REPEATABLE READ') return level
  throw CfKnexError.unsupportedTransactionMode(
    `isolation level '${mode.trim()}' is not supported by the tidb-http driver — only 'READ COMMITTED' and 'REPEATABLE READ' are.`,
  )
}
