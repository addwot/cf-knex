import { expect, test } from 'vitest'
import { CfKnexError } from '../../src/core/errors'
import { HOOK_TIMEOUT_MS, RETRY_BUDGET_MS, STALL_BUDGET_MS, retryStalledRequest } from '../support/stall'

// This covers test infrastructure rather than shipped code, which is unusual
// here and deliberate. The helper exists to keep a stalled hosted backend from
// reporting as an unattributable failure, and it silently stopped doing that
// once already: its worst case (three attempts, two statements each, at a 15s
// budget) was 75s inside a 30s `hookTimeout`, so it never reached its own
// give-up path and vitest killed the hook first. Nothing failed loudly — the
// suite simply went back to reporting `Hook timed out`, and the retry looked
// like it was working. These pin the parts that made it not work.

test('the retry budget fits inside the hook timeout it runs under', () => {
  // The invariant that broke. `HOOK_TIMEOUT_MS` is derived from
  // `RETRY_BUDGET_MS` so it cannot be set smaller, and vitest.config.ts
  // imports it rather than repeating the number.
  expect(HOOK_TIMEOUT_MS).toBeGreaterThan(RETRY_BUDGET_MS)
  // One attempt must fit too, or the very first attempt is unfinishable.
  expect(RETRY_BUDGET_MS).toBeGreaterThan(STALL_BUDGET_MS * 2)
})

test('gives up inside its budget rather than starting an attempt it cannot finish', async () => {
  const attempts: number[] = []
  const startedAt = performance.now()

  await expect(
    retryStalledRequest(
      async (attempt) => {
        attempts.push(attempt)
        await new Promise((resolve) => setTimeout(resolve, 100))
        throw CfKnexError.requestTimedOut('tidb-http', 100)
      },
      // Each attempt costs ~100ms and is quoted at 250ms, so after the first
      // (~100 + 250 = 350) there is room, and after the second (~200 + 250 =
      // 450) there is not. `attempts: 99` keeps the count out of it — what
      // stops this is the budget, not the cap.
      { attempts: 99, budgetMs: 400, retryCostMs: 250 },
    ),
    // Rethrows the error that names the budget. This is the whole point: the
    // caller learns a request stalled, instead of being killed from outside
    // and reporting a timeout that attributes nothing.
  ).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' })

  expect(attempts).toEqual([1, 2])
  expect(performance.now() - startedAt).toBeLessThan(400)
})

test('retries a stalled request until it succeeds', async () => {
  const attempts: number[] = []
  const got = await retryStalledRequest(async (attempt) => {
    attempts.push(attempt)
    if (attempt < 3) throw CfKnexError.requestTimedOut('tidb-http', STALL_BUDGET_MS)
    return 'ok'
  })
  expect(got).toBe('ok')
  expect(attempts).toEqual([1, 2, 3])
})

test('does not retry anything that is not a stall', async () => {
  const attempts: number[] = []
  await expect(
    retryStalledRequest(async (attempt) => {
      attempts.push(attempt)
      throw new Error('expected 1 to be 3')
    }),
  ).rejects.toThrow('expected 1 to be 3')
  // An adapter bug returns the wrong answer or hangs with no budget to exceed.
  // Both must still go red on the first attempt.
  expect(attempts).toEqual([1])
})
