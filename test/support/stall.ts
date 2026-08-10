import { CfKnexError } from '../../src/core/errors'

// `@tidbcloud/serverless` calls `fetch` with no signal, so a request that never
// comes back has nothing in the stack to end it. Bounding it with cf-knex's own
// `timeoutMs` is what turns that from an anonymous 30s hang into a failure that
// names the budget it blew.
//
// Sized against measurement, not intuition. A statement on a live TiDB Cloud
// Serverless cluster runs in 37-350ms (trivial SELECT ~40ms warm, DDL 120-350ms,
// first statement in a fresh process ~1.6s while the connection warms). The
// `live` CI runner is slower and, more importantly, *variably* slower: on one
// red run every hosted suite took about 1.5x what the same commit took on a
// green run — Turso 5.8s -> 9.1s and Neon 20.5s -> 31.7s alongside TiDB, three
// independent vendors, so the runner was degraded rather than any one backend
// stalling. Even so, 8s is roughly 8x the slowest single statement observed in
// CI, so a statement that blows this budget is not merely having a bad day.
//
// It must also stay clear of `STARVED_POOL_DEADLINE_MS` in ./conformance.ts
// (10s): that case distinguishes "the pool cannot supply a second connection"
// from ordinary latency, and it still does, because this budget bounds an
// in-flight HTTP request while a starved pool never issues one.
export const STALL_BUDGET_MS = 8_000

// The total wall clock `retryStalledRequest` may consume, which must stay
// strictly below `hookTimeout` in vitest.config.ts.
//
// That relationship is the whole point, and getting it backwards is what made
// an earlier attempt at this useless: with a 15s budget, 3 attempts and a retry
// that issues two statements, the worst case was 75s inside a 30s `hookTimeout`.
// The helper could never finish a retry — vitest killed the hook mid-flight and
// the failure reverted to `Hook timed out in 30000ms`, throwing away the
// attribution the budget existed to produce. Worst case is now 8s + 16s + 16s,
// measured at 40.0s against a hook that stalls on every attempt — under this
// ceiling, under that timeout. In practice it is nearer 25s, because a stalled
// statement rejects and the rest of its attempt never runs.
export const RETRY_BUDGET_MS = 45_000

// vitest's `hookTimeout`, *derived* from the budget above rather than written
// down next to it. The ordering between the two is the invariant that broke
// last time, and a constant that cannot be set smaller cannot break it again:
// the helper always reaches its own give-up path, and always rethrows an error
// that names what happened, before vitest kills the hook over the top of it.
// The margin covers the work a hook does outside the retry, such as building
// the client and (for tidb-http) warming a fresh connection.
export const HOOK_TIMEOUT_MS = RETRY_BUDGET_MS + 15_000

// vitest retries test bodies, never hooks. A stall inside `beforeAll` therefore
// takes every test in the suite down with it and no retry ever runs — one
// stalled CREATE TABLE skipping 40 conformance tests. This is the retry for the
// places vitest's own cannot reach; `vitest.config.ts` still covers test bodies.
//
// Deliberately narrow. It matches `REQUEST_TIMEOUT` and nothing else, so it is
// inert for every backend that does not set `timeoutMs`, and an adapter bug
// cannot reach it: a real bug returns the wrong answer, or hangs with no budget
// to exceed, and both still fail on the first attempt.
//
// `attempt` is handed back because an aborted request may still have been
// applied server-side — the error says so — so a caller repeating a write has
// to make it safe to repeat rather than assume it never landed. `retryCostMs`
// defaults to two statements for that reason: the caller that re-runs a write
// typically has to undo it first.
export async function retryStalledRequest<T>(
  operation: (attempt: number) => Promise<T>,
  { attempts = 3, budgetMs = RETRY_BUDGET_MS, retryCostMs = STALL_BUDGET_MS * 2 } = {},
): Promise<T> {
  const startedAt = performance.now()
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation(attempt)
    } catch (err) {
      const stalled = err instanceof CfKnexError && err.code === 'REQUEST_TIMEOUT'
      if (!stalled || attempt >= attempts) throw err
      // Start an attempt only if the whole of it fits in what is left. Giving
      // up here rethrows the CfKnexError naming the budget; starting an attempt
      // that cannot finish gets the caller killed by vitest instead, and that
      // failure names nothing.
      if (performance.now() - startedAt + retryCostMs > budgetMs) throw err
    }
  }
}
