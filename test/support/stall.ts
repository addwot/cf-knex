import { CfKnexError } from '../../src/core/errors'

// `@tidbcloud/serverless` calls `fetch` with no signal, so a TiDB Cloud
// Serverless request that never comes back has nothing in the stack to end it.
// That has taken the `live` job red on 2026-08-06 and twice on 2026-08-10,
// each time as a single statement going quiet while every other statement in
// the same run kept its usual timing.
//
// It really is a stall rather than ordinary slowness: measured against a live
// cluster, DDL has a median of 236ms and a maximum of 339ms, and DML a median
// of 54ms. Even the ~3x degradation seen during the 2026-08-10 failure leaves
// DDL near a second, so a statement that blows the budget below is not merely
// having a bad day.
//
// Well above that ceiling, and below vitest's 30s testTimeout so it is this
// that fires rather than an anonymous per-test timeout.
export const STALL_BUDGET_MS = 15_000

// vitest retries test bodies, never hooks. A stall inside `beforeAll` therefore
// takes every test in the suite down with it and no retry ever runs — which is
// exactly what happened on 2026-08-10, where one stalled CREATE TABLE skipped
// 40 conformance tests. This is the retry for the places vitest's own cannot
// reach; `vitest.config.ts` still covers the test bodies.
//
// Deliberately narrow. It matches `REQUEST_TIMEOUT` and nothing else, so it is
// inert for every backend that does not set `timeoutMs`, and an adapter bug
// cannot reach it: a real bug returns the wrong answer, or hangs with no budget
// to exceed, and both still fail on the first attempt.
//
// `attempt` is handed back because an aborted request may still have been
// applied server-side — the error says so — so a caller repeating a write has
// to make it safe to repeat rather than assume it never landed.
export async function retryStalledRequest<T>(
  operation: (attempt: number) => Promise<T>,
  attempts = 3,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation(attempt)
    } catch (err) {
      const stalled = err instanceof CfKnexError && err.code === 'REQUEST_TIMEOUT'
      if (!stalled || attempt >= attempts) throw err
    }
  }
}
