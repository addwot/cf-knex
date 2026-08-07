import { expect, test } from 'vitest'
import { createTidbHttpAdapter, resolveFetch } from '../../src/adapters/tidb-http'
import { CfKnexError } from '../../src/core/errors'

// Runs in workerd rather than Node because that is where this ships: both
// `AbortSignal.timeout` and `AbortSignal.any` are used below, and a bound that
// held only under Node would be worth nothing to a Worker.
//
// Nothing here reaches TiDB. Every case drives `resolveFetch` (or the adapter
// wrapping it) with a stub, so the timings are the test's own and the whole
// file runs in milliseconds — the live counterpart is in
// test/integration/tidb.test.ts.
// `u:p`, not a realistic-looking `user:pass`, matching the fixtures in
// tidb-http.test.ts. .gitleaks.toml's `cf-knex-db-url-credential` rule fires on
// an inline password of four characters or more against a non-local host, and
// a fixture is exactly the shape it is meant to catch — the one-character form
// stays clear of it without needing an allowlist entry.
const URL = 'mysql://u:p@x.tidbcloud.com:4000/db'

/** A `fetch` that never settles and ignores whatever signal it is handed. */
const deaf: typeof fetch = () => new Promise<Response>(() => {})

test('timeoutMs aborts a request that never comes back', async () => {
  const request = resolveFetch({ url: URL, timeoutMs: 30, fetch: deaf })
  await expect(request('https://example.com/')).rejects.toMatchObject({
    name: 'CfKnexError',
    code: 'REQUEST_TIMEOUT',
  })
})

test('the timeout holds even when the underlying fetch ignores the signal', async () => {
  // `deaf` above never settles and never listens to `signal`, so passing the
  // signal through cannot be what ends this — only the race can. This is the
  // case that separates a real bound from one that merely asks politely.
  const startedAt = Date.now()
  const request = resolveFetch({ url: URL, timeoutMs: 40, fetch: deaf })
  await expect(request('https://example.com/')).rejects.toThrow(/exceeded the 40ms timeoutMs budget/)
  expect(Date.now() - startedAt).toBeLessThan(2000)
})

test('the message says the write may still land, because an abort is local', async () => {
  const request = resolveFetch({ url: URL, timeoutMs: 10, fetch: deaf })
  // A caller who reads this as "the statement did not run" would retry a
  // non-idempotent write. The wording is the only thing standing between the
  // two readings, so it is asserted rather than left to drift.
  await expect(request('https://example.com/')).rejects.toThrow(/unknown outcome rather than as failed/)
})

test('the signal is passed down too, so a well-behaved fetch is cancelled rather than abandoned', async () => {
  let observed: AbortSignal | undefined
  const listening: typeof fetch = (_input, init) =>
    new Promise<Response>((_, reject) => {
      observed = init?.signal ?? undefined
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted by signal')), { once: true })
    })

  const request = resolveFetch({ url: URL, timeoutMs: 30, fetch: listening })
  await expect(request('https://example.com/')).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' })
  expect(observed).toBeInstanceOf(AbortSignal)
  expect(observed?.aborted).toBe(true)
})

test("a caller's own cancellation surfaces as itself, not as a timeout", async () => {
  const controller = new AbortController()
  const listening: typeof fetch = (_input, init) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('caller aborted')), { once: true })
    })

  // A generous budget that will not fire, so the only thing that can end this
  // is the caller's own signal. Reporting that as REQUEST_TIMEOUT would blame
  // the library for something the caller asked for.
  const request = resolveFetch({ url: URL, timeoutMs: 10_000, fetch: listening })
  const pending = request('https://example.com/', { signal: controller.signal })
  controller.abort()
  await expect(pending).rejects.toThrow('caller aborted')
})

test('a failure that is not a timeout passes through unchanged', async () => {
  const refusing: typeof fetch = () => Promise.reject(new Error('ECONNREFUSED'))
  const request = resolveFetch({ url: URL, timeoutMs: 5_000, fetch: refusing })
  // Not merely "rejects" — rejects with the original error. Wrapping every
  // failure as a timeout would hide the one detail worth having.
  await expect(request('https://example.com/')).rejects.toThrow('ECONNREFUSED')
})

test('omitting timeoutMs hands the driver the exact fetch it was given, unwrapped', async () => {
  const custom: typeof fetch = () => Promise.reject(new Error('called'))
  // Identity, not behaviour: this is what makes "no timeout costs nothing"
  // checkable, and it pins that a client which asks for no bound is byte-for-byte
  // on the path that existed before this option.
  expect(resolveFetch({ url: URL, fetch: custom })).toBe(custom)
  expect(resolveFetch({ url: URL })).toBe(fetch)
})

test('the adapter routes its driver traffic through the supplied fetch', async () => {
  const seen: string[] = []
  const recording: typeof fetch = (input) => {
    seen.push(String(input))
    return Promise.reject(new Error('stubbed'))
  }

  const adapter = createTidbHttpAdapter({ url: URL, fetch: recording })
  const conn = await adapter.acquire()
  await expect(adapter.execute(conn, 'SELECT 1', [])).rejects.toThrow('stubbed')

  // Proves the hook reaches the driver rather than only being stored: without
  // it the request would have gone to the network through the global fetch.
  expect(seen).toHaveLength(1)
  expect(seen[0]).toContain('x.tidbcloud.com')
})

test('a timed-out query surfaces as CfKnexError through the adapter, not just through resolveFetch', async () => {
  const adapter = createTidbHttpAdapter({ url: URL, timeoutMs: 30, fetch: deaf })
  const conn = await adapter.acquire()

  const err = await adapter.execute(conn, 'SELECT 1', []).catch((e: unknown) => e)
  expect(err).toBeInstanceOf(CfKnexError)
  expect((err as CfKnexError).code).toBe('REQUEST_TIMEOUT')
})
