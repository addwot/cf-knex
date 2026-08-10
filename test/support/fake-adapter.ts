import type { AdapterCapabilities, CapabilityHints, Dialect, DriverAdapter, RawResult } from '../../src/core/types'

export function createFakeAdapter(opts: {
  dialect: Dialect
  result?: Partial<RawResult>
  // Opts a fake handle into going "stale" the moment it's used once, so a
  // test can exercise the pool-eviction path `DriverAdapter.validate` exists
  // for (src/core/types.ts) without a real database: tarn calls `validate`
  // before handing a pooled handle back out, so a query run against a
  // handle this flipped stale should force a fresh `acquire()` instead of
  // reusing it. Omitted entirely (not just `undefined`) unless this is set,
  // matching every other fake adapter in this file — a `DriverAdapter`
  // without `validate` at all is "always valid", the default every adapter
  // that can't go stale (tidb-http, d1) actually needs; adding it always,
  // even as a no-op true, would stop that default path from being the one
  // every other test in this suite exercises.
  invalidateAfterFirstUse?: boolean
  // Merged over the default `{ streaming: false, transactions: true }`
  // rather than replacing it outright, so a test that only cares about one
  // flag (e.g. asserting `createKnexClient` rejects `db.transaction()` when
  // an adapter declares `capabilities.transactions: false`) doesn't have to
  // restate the other.
  capabilities?: Partial<AdapterCapabilities>
  // Passed straight through to the returned adapter's own `hints`. Omitted
  // entirely unless supplied — same "omit, don't set to `undefined`"
  // contract `DriverAdapter.hints` itself documents (src/core/types.ts) —
  // so a test asserting today's generic hint wording doesn't have to
  // special-case this option too.
  hints?: CapabilityHints
  // Gives this adapter a real `stream()` without a database — e.g. a small
  // async generator yielding fixed rows, or one that throws partway through
  // to exercise `_stream()`'s error/backpressure paths. Omitted entirely
  // unless supplied, matching `capabilities.streaming` defaulting to
  // `false` below: most of this suite needs a `DriverAdapter` with no
  // `stream` method at all, and `_stream()` (src/core/client.ts) is
  // specifically required to gate on *both* `capabilities.streaming` and
  // `stream`'s presence — a test that sets one without the other exercises
  // that gate directly.
  stream?: DriverAdapter['stream']
  // Makes `destroy()` a promise that never settles, so a test can drive
  // `Client.destroy()`'s second budget — the one around `adapter.destroy()`
  // itself (src/core/client.ts). Distinct from a `destroy()` that *rejects*:
  // a rejection is already a settled outcome, and only a promise that never
  // settles exercises the timeout. Omitted entirely unless set, like every
  // other option here.
  hangOnDestroy?: boolean
  // Lets a test fail one specific statement without a database, by returning
  // an error for the SQL it cares about and `undefined` for everything else.
  // Needed for the statements knex issues *itself* — `BEGIN`, `COMMIT`,
  // `ROLLBACK`, `SAVEPOINT` — which a test can't reach through a query
  // builder at all, and whose failure knex handles on a different path from a
  // failing user query (execution/transaction.js's `query()` swallows the
  // rejection and re-routes it to the transaction's own promise). Distinct
  // from making every `execute()` reject: the transaction has to get far
  // enough to open and do work before the statement under test runs.
  // Omitted entirely unless set, like every other option here.
  failExecute?: (sql: string) => Error | undefined
}) {
  const calls: Array<{ sql: string; bindings: unknown[] }> = []
  // `createKnexClient` (src/core/client.ts) wires `acquire`/`release`/
  // `destroy` into knex's real tarn pool now, rather than calling into them
  // once per query — so, unlike `calls` above, these three fire on
  // whatever schedule tarn chooses (lazily, on demand, and not necessarily
  // once per handle handed out). `released` is keyed on the handle itself
  // so a test can assert a *specific* acquired handle was released, not
  // just that release fired some number of times.
  let acquireCount = 0
  let destroyCount = 0
  const released = new Set<unknown>()
  const handles: object[] = []
  const usedOnce = new Set<unknown>()
  const adapter: DriverAdapter = {
    dialect: opts.dialect,
    driver: 'mysql2',
    capabilities: { streaming: false, transactions: true, ...opts.capabilities },
    // Spread in at construction, not assigned after like `validate`/`stream`
    // below: `DriverAdapter.hints` is `readonly` (src/core/types.ts), so an
    // assignment once `adapter` is already typed as `DriverAdapter` would be
    // a compile error, not just a style choice.
    ...(opts.hints ? { hints: opts.hints } : {}),
    acquire: async () => {
      acquireCount++
      const handle = {}
      handles.push(handle)
      return handle
    },
    release: async (handle) => {
      released.add(handle)
    },
    execute: async (h, sql, bindings) => {
      calls.push({ sql, bindings })
      usedOnce.add(h)
      const failure = opts.failExecute?.(sql)
      if (failure) throw failure
      return { rows: [], ...opts.result } as RawResult
    },
    destroy: async () => {
      destroyCount++
      if (opts.hangOnDestroy) await new Promise<never>(() => {})
    },
  }
  if (opts.invalidateAfterFirstUse) {
    adapter.validate = (handle: unknown) => !usedOnce.has(handle)
  }
  if (opts.stream) {
    adapter.stream = opts.stream
  }
  return {
    adapter,
    calls,
    acquireCount: () => acquireCount,
    destroyCount: () => destroyCount,
    handles,
    wasReleased: (handle: unknown) => released.has(handle),
  }
}
