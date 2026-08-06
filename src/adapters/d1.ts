import { CfKnexError } from '../core/errors'
import type { DriverAdapter, RawResult } from '../core/types'

/**
 * The subset of a D1 binding this adapter calls. Declared locally rather
 * than importing `@cloudflare/workers-types`' own `D1Database` /
 * `D1PreparedStatement` / `D1Result` for one reason, not the shape of the
 * package itself:
 *
 * - `@cloudflare/workers-types` does ship a real, importable module —
 *   `import type { D1Database } from '@cloudflare/workers-types'` resolves
 *   (verified against this project's own `tsc`, `--traceResolution` landing
 *   on `.../@cloudflare/workers-types/index.ts`, exit 0) because that
 *   package's `package.json` has no `main`/`types`/`exports` field, so
 *   TypeScript's default file-extension search finds `index.ts` (965
 *   `export` statements, including `export declare abstract class
 *   D1Database`) ahead of the ambient, zero-export `index.d.ts` sitting next
 *   to it. That resolution is an artifact of the package having no explicit
 *   entry point, not a documented or stable contract — not something this
 *   file should depend on.
 * - This project's own precedent is not to reach for the ambient Workers
 *   type even where it *is* usable: src/adapters/mysql2.ts declares its own
 *   `HyperdriveConfig` (five fields) rather than using the ambient
 *   `Hyperdrive` interface, specifically to pin the adapter's contract to
 *   only what it reads. `src/core/infer.ts`'s `isD1Binding` makes the same
 *   choice from the other side — it accepts any object with a `prepare`
 *   method, structurally, rather than requiring the ambient `D1Database`
 *   type. `ClientConfig.binding` (src/core/types.ts) is typed `unknown` for
 *   the same reason. Matching that here keeps `createD1Adapter`'s public
 *   signature independent of whether a consumer's own tsconfig resolves
 *   `@cloudflare/workers-types` the same accidental way — this package has
 *   no peer dependency on it (unlike `mysql2`/`pg`/`@tidbcloud/serverless`/
 *   `@libsql/client`, all listed in package.json).
 *
 * The shape below is still the real one, not a guess: `results`/`meta` (and
 * `meta.last_row_id`/`meta.changes`) are typed as always-present, matching
 * the ambient `D1Response`/`D1Result`/`D1Meta` exactly (`success: true` is a
 * literal type there, `results: T[]` and `meta: D1Meta & Record<string,
 * unknown>` are both required, and `D1Meta.last_row_id`/`.changes` are both
 * plain `number`, never optional) — see `toRawResult` below for why that
 * requiredness is trusted rather than re-guarded with `?.`/`??`.
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
 * ## Streaming
 * `capabilities.streaming` is `false`: `D1PreparedStatement.all()` (the only
 * row-returning method this adapter's `execute()` calls) always resolves
 * with the complete `results` array — there is no cursor or chunked-read API
 * on `D1Database`/`D1PreparedStatement` (`@cloudflare/workers-types/
 * index.d.ts`) for `DriverAdapter.stream()` to wrap, the same reasoning
 * src/adapters/tidb-http.ts documents for its own `false`.
 *
 * ## Transactions
 * `capabilities.transactions` is `false`: `D1Database` (index.d.ts) exposes
 * no `begin()`/`commit()`/`rollback()` and no interactive-session primitive
 * at all — only `prepare()`, `batch()`, `exec()`, and `withSession()` (which
 * anchors a *read* replica-consistency window, not a write transaction).
 * Routing knex's BEGIN/COMMIT/ROLLBACK through this adapter's `execute()` the
 * way src/adapters/tidb-http.ts routes them through its own `execute()`
 * is not an option here at all — D1 has nothing on the other end to
 * interpret those three statements as anything but three independent,
 * unrelated queries. `hints.transactions` below names `batch()` as the
 * actionable alternative instead of leaving the caller to guess: D1's own
 * backend (`miniflare`'s `src/workers/d1/database.worker.ts`, the `#txn`
 * method) wraps every request's statement list — a `batch()` call's
 * statements arrive as one such list — in a single
 * `this.state.storage.transactionSync(...)` call,
 * so a `batch()` submission either commits every statement in it or none of
 * them. That is confirmed against miniflare's D1 backend (this project's own
 * test harness), not against the production Cloudflare edge D1 gateway
 * directly — no production D1 account was available to verify the gateway's
 * own handling of a `batch()` call end to end from here, the same caveat
 * src/adapters/tidb-http.ts's doc comment carries for its own unverified
 * production claim. Unlike that file's `capabilities.transactions`, this
 * doesn't change what this adapter reports: `batch()` is a real, separate
 * method a caller can reach directly off the binding regardless of what this
 * adapter declares — the hint just names it.
 *
 * ## `Date`/boolean bindings: normalized before they ever reach this file
 * `.bind(new Date())` against the real binding throws `D1_TYPE_ERROR: Type
 * 'object' not supported for value '...'` — confirmed directly against
 * `env.DB` and still pinned by a regression test in `test/unit/d1.test.ts`.
 * This adapter's own `execute()` never sees that failure, though: `../core/
 * client.ts`'s `CfKnexClient.prepBindings` converts every `Date` to
 * `.valueOf()` (an epoch-ms number) and every `boolean` to `0`/`1` before
 * bindings reach *any* sqlite-family adapter's `execute()`, matching how
 * knex's own `better-sqlite3` dialect (`node_modules/knex/lib/dialects/
 * better-sqlite3/index.js`'s `_formatBindings`) treats the same two types —
 * the base `Client.prepBindings` (`node_modules/knex/lib/client.js`) is a
 * plain passthrough, and knex's own sqlite3 dialect never overrides it, so
 * without that conversion a `Date` a caller passed to e.g. `.insert({
 * createdAt: new Date() })` would have reached this file's `execute()`
 * exactly as given, with nothing in between to convert it. A `bigint`
 * binding gets no such conversion — `better-sqlite3` doesn't convert it
 * either — so it still reaches this adapter unchanged and D1 still rejects
 * it the same way (`D1_TYPE_ERROR: Type 'bigint' not supported`), a real,
 * measured, currently-unfixed limitation distinct from the `Date` case.
 * `test/support/conformance.ts` never inserts a `Date` or a `bigint`, so
 * neither is visible to the shared suite.
 *
 * ## Routing every `acquire()` call through one underlying binding
 * `acquire()` below returns a fresh wrapper object every call (see its own
 * comment for why the wrapper exists — a separate, knex-pool-specific
 * reason), but every one of those wrappers still forwards to the *same*
 * `opts.binding.prepare(...)`. That sharing is the same shape src/adapters/
 * mysql2.ts and src/adapters/tidb-http.ts both got wrong once — a fresh
 * `Connection` per call was the fix in both those files, because their
 * handle type carries per-instance state a concurrent, unrelated caller
 * could stomp on: mysql2's `Connection` owns one TCP socket and one
 * server-side session; `@tidbcloud/serverless`'s `Connection` carries a
 * private `this.session` field threaded through every `execute()` call.
 *
 * A `D1Database` is not stateless in the way an earlier version of this
 * comment claimed — `@cloudflare/workers-types`'s ambient `.d.ts` is a
 * hand-written public surface and cannot show implementation fields either
 * way, so that claim needed checking against the runtime object, not the
 * type. Checked directly, against the real binding inside this project's own
 * `workers` vitest project (`vitest-pool-workers`, which runs the actual D1
 * implementation, not a hand-rolled stub): `env.DB`'s own properties are
 * `["alwaysPrimarySession", "fetcher"]`, and every `D1PreparedStatement`
 * returned by `env.DB.prepare(...)` carries a `dbSession` property that is
 * `=== env.DB.alwaysPrimarySession` — the same session object, every call.
 * That session object does carry mutable-looking state: a `bookmarkOrConstraint`
 * field and an `_updateBookmark` method, matching the ambient `D1Database
 * .withSession(constraintOrBookmark)`'s doc comment ("Creates a new D1
 * Session anchored at the given constraint or the bookmark"). What makes
 * sharing it safe is not that this field doesn't exist, but that it never
 * moves off `null` for the path this adapter actually uses: `bookmarkOrConstraint`
 * on `alwaysPrimarySession` stayed `null` before and after a CREATE TABLE, an
 * INSERT, and a SELECT issued through it (`test/unit/d1.test.ts`'s
 * binding-sharing tests assert the parts of this that are observable
 * without reaching into implementation-private fields). This adapter never calls
 * `withSession(...)` — the one documented way to anchor that field to
 * something — so the one piece of session state a `D1Database` does carry is
 * never populated through any path this adapter takes. This was checked
 * against the miniflare-backed D1 implementation this project's own test
 * harness provides, not against the production Cloudflare edge gateway's
 * internal implementation directly — no production D1 account was available
 * to verify workerd's own binding behaves identically, the same caveat this
 * file's `batch()` atomicity claim above carries.
 *
 * `prepare(query)` returning a brand-new `D1PreparedStatement` on every call,
 * and `bind(...)` returning a new statement rather than mutating the one it
 * was called on, are both asserted directly in `test/unit/d1.test.ts` rather
 * than only claimed here — together they're why two callers issuing
 * unrelated queries through the same `D1Database` reference (via two
 * different `acquire()` wrappers, or the same one reused) each get their own
 * independent statement/params pair, never a shared or mutated one.
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

    // A fresh, minimal delegating wrapper on every call — never `opts.binding`
    // itself. See this function's doc comment above for why the *sharing*
    // this wrapper still funnels every call through one underlying
    // `D1Database` is safe; the wrapper exists for an unrelated reason: knex's
    // pool writes directly onto whatever object `acquireRawConnection`
    // returns. `node_modules/knex/lib/execution/runner.js` sets
    // `connection.__knex__disposed = error` on a connection knex has decided
    // to discard (lines 194 and 204, two different failure paths that both do
    // it), and `node_modules/knex/lib/client.js`'s `connectionIsDisposed`
    // (defined line 308, `if (connection.__knex__disposed) { … return true }`,
    // wired into the pool's own `validate` at lines 370-371) makes
    // `validateConnection` return `false` for that exact object forever
    // after — nothing in knex ever clears `__knex__disposed` once set. For
    // every other adapter in this project that mark dies with the handle:
    // mysql2's `release()` closes its `Connection` (`conn.end()`) and it is
    // never seen again; src/adapters/tidb-http.ts's `release()` closes
    // nothing (its handle owns no I/O to close either) but still discards
    // the handle itself, so the mark goes with it either way. `opts.binding`
    // has no such lifecycle — it is the caller's own long-lived binding — so
    // a mark written onto it directly would (a) mutate an object this
    // adapter does not own, and (b) poison every future pool this adapter
    // (or a second `createD1Adapter` call over the same binding) ever builds
    // over it, permanently, for the lifetime of the isolate — not a
    // per-connection problem but a per-binding one. A fresh `{ prepare }`
    // object each `acquire()` call gives knex something disposable to write
    // on instead, restores the ordinary "one mark, one handle, one release"
    // lifecycle every other adapter already has, and costs nothing beyond
    // the one extra call: it forwards straight to `opts.binding.prepare(...)`,
    // the only method `execute()` below calls. That narrowing is deliberate,
    // not just minimal: `opts.binding` also exposes `batch()`/`exec()`/
    // `withSession()`, and this wrapper does not forward any of them, so
    // anything that reaches an acquired handle directly (e.g. through
    // knex's own `db.client.acquireConnection()`) sees `prepare()` only.
    // `hints.transactions` above points a caller at "the binding's own
    // `batch()`" specifically because it is not reachable through an
    // acquired handle — a caller has to go back to the original binding it
    // passed into `createD1Adapter({ binding })` to call it.
    async acquire(): Promise<D1DatabaseLike> {
      return { prepare: (query: string) => opts.binding.prepare(query) }
    },

    // Genuinely nothing to close: `acquire()` above hands out a plain
    // forwarding wrapper over a binding this adapter never opened and
    // doesn't own the lifecycle of — there is no socket, file descriptor, or
    // server-side session tied to any single `acquire()` call for this to
    // release, whether or not the object itself is fresh each time. Contrast
    // src/adapters/mysql2.ts's `release()`, which does real I/O
    // (`conn.end()`) because its handle genuinely owns one.
    async release(): Promise<void> {},

    async execute(handle, sql, bindings): Promise<RawResult> {
      const db = handle as D1DatabaseLike
      // Always call `.bind(...)`, even with zero bindings: `D1PreparedStatement
      // .bind(...values: unknown[])` (index.d.ts) takes a variadic rest
      // parameter, so `.bind()` with no arguments is a valid call, not a
      // special case to branch around — confirmed empirically against the
      // real binding (a query with no placeholders, bound with zero
      // arguments, executes identically to one never bound at all). One
      // code path here instead of two.
      const result = await db.prepare(sql).bind(...bindings).all()
      return toRawResult(result)
    },

    // Nothing for this adapter to tear down beyond individual handles, and
    // there are none of those either (see `release()` above) — trivially
    // idempotent since it does nothing every time it's called, matching
    // src/adapters/tidb-http.ts's `destroy()`.
    async destroy(): Promise<void> {},

    // No `validate()` — omitted entirely, matching src/adapters/tidb-http.ts.
    // src/core/types.ts's `DriverAdapter` doc comment names D1 specifically:
    // "binding-backed ones (D1) hand out an object with no underlying
    // session to drop." There is nothing about the wrapper `acquire()`
    // above hands out that can go stale between queries — no socket to drop,
    // no session to expire, and the underlying `D1Database` it forwards to
    // is shared and stateless in the way documented above — so
    // `createKnexClient` (../core/client.ts) treating a missing `validate`
    // as "always valid" is the correct behavior here, not a stricter check
    // to opt back out of.
  }
}

/**
 * `execute()` above always calls `.all()`, so a well-formed response is
 * exactly the ambient `D1Result` shape (`@cloudflare/workers-types/
 * index.d.ts`): `{ success: true, meta: D1Meta & Record<string, unknown>,
 * results: T[] }`, with `D1Meta.last_row_id`/`.changes` both plain `number`
 * — every one of those fields is required by that type, none optional, and
 * `success` is a literal `true` (there is no `success: false` variant of
 * `D1Response` to union against).
 *
 * That requiredness is trusted, not re-guarded with `??`/`?.` back to
 * `[]`/`undefined` the way the D1 API's own backend (visible in
 * `miniflare`'s `src/workers/d1/database.worker.ts`) represents a *failed*
 * query: as a thrown `D1Error` (`toResponse()` there returns `{ success:
 * false, error: … }`,
 * with no `results`/`meta` at all), not a resolved value shaped like this
 * one with a `false` flag buried in it. Confirmed empirically too, against
 * the real binding: a query against a table that doesn't exist rejects
 * `.all()`'s promise (`D1_ERROR: no such table: … SQLITE_ERROR`) rather than
 * resolving with `success: false`. A resolved call, in other words, is
 * exactly the case `D1Response.success: true` already commits to at the type
 * level — there is no reachable "resolved but unsuccessful" case for this
 * function to additionally guard against.
 *
 * What *is* still guarded, the same way src/adapters/mysql2.ts's own
 * `toRawResult` guards a driver-typed (not JSON-over-HTTP) result despite
 * mysql2's own `.d.ts` making the same "this shape is guaranteed" promise:
 * `D1DatabaseLike` above is this adapter's own structural shim, not the real
 * `D1Database` (see this file's top comment for why) — a caller can hand
 * `createD1Adapter` anything shaped like `{ prepare }`, including a test
 * double or an unrelated binding, and nothing at the type level stops
 * `.all()` from resolving to something that isn't a `D1Result` at all.
 * Silently defaulting a missing/malformed `results` to `[]` or a
 * missing/malformed `meta.last_row_id`/`.changes` to `undefined` would turn
 * that mismatch into a query that looks like it succeeded with no rows
 * affected — exactly the "silently-wrong success" failure mode this
 * project's guard functions (this one, and src/adapters/tidb-http.ts's)
 * exist to convert into a loud, typed `CfKnexError` instead.
 *
 * Deliberately NOT re-checked, because the ambient type already makes it
 * impossible for a conforming response: `success`'s exact value ("D1's HTTP
 * backend can't hand back `results`/`meta` alongside `success: false`" is
 * established above, not merely assumed), and the type of `meta`'s other
 * fields (`duration`, `rows_read`, `rows_written`, `changed_db`, …) — none of
 * which this adapter reads, so a defect in one of them would never reach a
 * caller through this file regardless.
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
