import { CfKnexError } from '../core/errors'
import type { DriverAdapter, RawResult } from '../core/types'

/**
 * D1's binding surface is declared locally rather than importing
 * `@cloudflare/workers-types`' `D1Database`/`D1PreparedStatement`/`D1Result`.
 * That ambient package IS importable (its `package.json` has no `main`/
 * `types`/`exports`, so TS's default resolution finds `index.ts`, not
 * `index.d.ts`), but this project's convention is to avoid depending on it
 * anyway — see src/adapters/mysql2.ts's own `HyperdriveConfig`, src/core/
 * infer.ts's structural `isD1Binding`, and `ClientConfig.binding: unknown` —
 * since this package has no peer dependency on `@cloudflare/workers-types`
 * (unlike mysql2/pg/tidbcloud/libsql).
 *
 * The shape below still matches the ambient `D1Response`/`D1Result`/`D1Meta`
 * exactly — `results`/`meta`/`meta.last_row_id`/`meta.changes` are all
 * required, never optional — which is why `toRawResult` below trusts their
 * presence instead of guarding with `?.`/`??`.
 */
type D1PreparedStatementLike = {
  bind(...values: unknown[]): D1PreparedStatementLike
  all(): Promise<unknown>
}

type D1DatabaseLike = {
  prepare(query: string): D1PreparedStatementLike
}

export type D1AdapterOptions = { binding: D1DatabaseLike }

/**
 * A `DriverAdapter` over a Cloudflare D1 binding (`env.DB`-style).
 *
 * ## Streaming: false
 * `D1PreparedStatement.all()` — the only row-returning method `execute()`
 * calls — always resolves the complete `results` array; D1 has no cursor or
 * chunked-read API to wrap. Same reasoning as src/adapters/tidb-http.ts.
 *
 * ## Transactions: false
 * `D1Database` has no `begin()`/`commit()`/`rollback()`, and `withSession()`
 * anchors a read replica-consistency window, not a write transaction — so
 * knex's BEGIN/COMMIT/ROLLBACK can't be routed through `execute()` the way
 * tidb-http.ts routes them. `hints.transactions` below points callers at
 * `batch()` instead: miniflare's D1 backend (`database.worker.ts`'s `#txn`)
 * wraps a batch's statement list in one `transactionSync(...)` call, so it
 * either all commits or none of it does. Confirmed against miniflare's D1
 * implementation only — no production D1 account was available to verify
 * the Cloudflare edge gateway handles `batch()` the same way.
 *
 * ## `Date`/boolean bindings are normalized upstream
 * `.bind(new Date())` against the real binding throws `D1_TYPE_ERROR: Type
 * 'object' not supported` (regression-tested in test/unit/d1.test.ts), but
 * this adapter's `execute()` never sees that: `../core/client.ts`'s
 * `CfKnexClient.prepBindings` converts every `Date` to `.valueOf()` and every
 * `boolean` to `0`/`1` before bindings reach any sqlite-family adapter,
 * matching knex's own better-sqlite3 dialect. `bigint` gets no such
 * conversion and still reaches D1 unchanged, where it's rejected the same
 * way (`D1_TYPE_ERROR: Type 'bigint' not supported`) — a real, unfixed gap
 * the shared conformance suite doesn't exercise.
 *
 * ## Every `acquire()` shares one underlying binding
 * `acquire()` returns a fresh wrapper each call (see its own comment for
 * why), but every wrapper forwards to the same `opts.binding.prepare(...)`.
 * That's safe here in a way it wasn't for mysql2.ts/tidb-http.ts's own
 * `Connection` types, which own per-instance state (a TCP socket + session,
 * or a private `this.session`) a concurrent caller could stomp on. Checked
 * directly against the real binding (via `vitest-pool-workers`, which runs
 * the actual D1 implementation): `env.DB`'s own properties are just
 * `["alwaysPrimarySession", "fetcher"]`, and every `D1PreparedStatement` it
 * hands out carries a `dbSession` that is `=== env.DB.alwaysPrimarySession`
 * — the same session object every call. That session does carry mutable
 * state (`bookmarkOrConstraint`, matching `withSession()`'s doc comment),
 * but it stayed `null` across a CREATE TABLE, an INSERT, and a SELECT in
 * testing, and this adapter never calls `withSession(...)` — the only way to
 * populate it — so sharing the binding across `acquire()` calls never
 * exposes that state. `prepare()`/`bind()` both return fresh objects rather
 * than mutating in place (asserted in test/unit/d1.test.ts), so two callers
 * sharing a `D1Database` reference never share a statement or params array.
 * Verified against miniflare's D1 implementation, not production D1.
 */
export function createD1Adapter(opts: D1AdapterOptions): DriverAdapter {
  return {
    dialect: 'sqlite',
    driver: 'd1',
    capabilities: { streaming: false, transactions: false },

    hints: {
      transactions:
        "D1 has no interactive transaction session (no BEGIN/COMMIT/ROLLBACK) -- use the binding's own batch() " +
        'to submit multiple statements as one atomic unit instead: they either all commit or none do, without ' +
        'holding an open session between them the way an interactive transaction would.',
    },

    // Fresh, minimal `{ prepare }` wrapper each call — never `opts.binding`
    // itself. Knex writes `connection.__knex__disposed = error` directly onto
    // whatever `acquireRawConnection` returns when it discards a connection
    // (node_modules/knex/lib/execution/runner.js), and that mark is never
    // cleared, so `validateConnection` treats the same object as permanently
    // invalid forever after. For other adapters that mark dies with the
    // handle (mysql2 closes its `Connection`; tidb-http discards its handle
    // either way). `opts.binding` has no such lifecycle — it's the caller's
    // own long-lived binding — so writing the mark onto it directly would
    // poison every future pool built over that binding, for the isolate's
    // lifetime. A fresh object per `acquire()` gives knex something
    // disposable instead, and forwards only `prepare()`: `opts.binding` also
    // exposes `batch()`/`exec()`/`withSession()`, none of which are reachable
    // through an acquired handle — `hints.transactions` above points callers
    // back to the original binding for `batch()` specifically because of
    // that.
    async acquire(): Promise<D1DatabaseLike> {
      return { prepare: (query: string) => opts.binding.prepare(query) }
    },

    // Nothing to close: the wrapper `acquire()` hands out owns no socket,
    // file descriptor, or session — `opts.binding`'s lifecycle isn't this
    // adapter's to manage. Contrast mysql2.ts's `release()`, which does real
    // I/O (`conn.end()`) because its handle owns a connection.
    async release(): Promise<void> {},

    async execute(handle, sql, bindings): Promise<RawResult> {
      const db = handle as D1DatabaseLike
      // `.bind(...)` takes a variadic rest param, so calling it with zero
      // arguments is valid, not a special case — confirmed empirically: a
      // query with no placeholders, bound with zero args, executes
      // identically to one never bound at all.
      const result = await db.prepare(sql).bind(...bindings).all()
      return toRawResult(result)
    },

    // Nothing to tear down beyond individual handles, and there are none
    // (see `release()` above) — trivially idempotent, matching tidb-http.ts.
    async destroy(): Promise<void> {},

    // No `validate()` — matching tidb-http.ts. src/core/types.ts's
    // `DriverAdapter` doc comment names D1 specifically as a binding-backed
    // adapter with no underlying session to drop, so `createKnexClient`
    // treating a missing `validate` as "always valid" is correct here.
  }
}

/**
 * `execute()` above always calls `.all()`, so a well-formed response matches
 * the ambient `D1Result` shape exactly: `{ success: true, meta: D1Meta &
 * Record<string, unknown>, results: T[] }`, with every field required, none
 * optional. That requiredness is trusted, not re-guarded with `?.`/`??` —
 * confirmed empirically that a failed query (e.g. against a nonexistent
 * table) rejects `.all()`'s promise (`D1_ERROR: no such table: …`) rather
 * than resolving with `success: false`; D1's backend represents failure as a
 * thrown error, never a resolved-but-unsuccessful value, so there's no
 * reachable case to guard against here.
 *
 * What IS still guarded, the same way mysql2.ts's `toRawResult` does:
 * `D1DatabaseLike` above is this adapter's own structural shim, not the real
 * `D1Database` — a caller can pass `createD1Adapter` anything shaped like
 * `{ prepare }`, so nothing at the type level stops `.all()` resolving to
 * something that isn't a `D1Result`. Silently defaulting a missing/malformed
 * `results`/`meta.last_row_id`/`.changes` would turn that mismatch into a
 * query that looks like it succeeded with no rows affected — this function
 * converts that into a loud `CfKnexError` instead.
 *
 * Not re-checked: `meta`'s other fields (`duration`, `rows_read`, …), since
 * this adapter never reads them.
 */
function toRawResult(result: unknown): RawResult {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    throw CfKnexError.malformedResult(
      `d1 query did not return a D1Result object (got ${Array.isArray(result) ? 'an array' : result === null ? 'null' : typeof result})`,
    )
  }

  const { results, meta } = result as { results?: unknown; meta?: unknown }

  if (!Array.isArray(results)) {
    throw CfKnexError.malformedResult(`d1 query's 'results' was not an array (got ${typeof results})`)
  }
  if (meta === null || typeof meta !== 'object') {
    throw CfKnexError.malformedResult(`d1 query's 'meta' was not an object (got ${meta === null ? 'null' : typeof meta})`)
  }

  const { last_row_id: lastRowId, changes } = meta as { last_row_id?: unknown; changes?: unknown }
  if (typeof lastRowId !== 'number') {
    throw CfKnexError.malformedResult(`d1 query's 'meta.last_row_id' was not a number (got ${typeof lastRowId})`)
  }
  if (typeof changes !== 'number') {
    throw CfKnexError.malformedResult(`d1 query's 'meta.changes' was not a number (got ${typeof changes})`)
  }

  return { rows: results, insertId: lastRowId, affectedRows: changes }
}
