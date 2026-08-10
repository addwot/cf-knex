import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'
import { HOOK_TIMEOUT_MS } from './test/support/stall'

// The `node` project reads `process.env` and nothing else fills it — the
// "Using secrets defined in .env" line is miniflare's and covers `workers`
// alone, so without this every integration suite silently falls back to its
// `test.skip` placeholder. Not a `--env-file` flag on the npm scripts: this
// also covers watch mode and IDE runners, and needs nothing newer than
// `engines.node` (">=22"), which `--env-file-if-exists` (22.9) would.
// Already-set variables win, so CI's secrets are never shadowed.
try {
  process.loadEnvFile('.env')
} catch {
  // No `.env` — normal in CI and a fresh clone.
}

// Three projects. `workers`/`node` split because @cloudflare/vitest-pool-workers
// cannot import `mysql2` or `pg` at all — both are CJS packages with dual
// ESM/CJS exports maps and bare Node-builtin requires the pool's module
// loader can't resolve. `workers` runs inside workerd for anything that
// must be proven to work there; `node` runs in plain Node for real TCP
// driver tests. `types` is separate again: `typecheck.enabled` runs tsc over
// its files *and* still executes their `test()` bodies as ordinary runtime
// code (confirmed directly — see test/types/api.test-d.ts's own comments
// for what that requires its fixtures to tolerate), so it needs its own
// `include` rather than folding into `node`.
//
// The two `include` globs below are a runtime boundary, not a test-kind
// boundary: `test/unit/**` means "runs in workerd", `test/integration/**`
// means "runs in plain Node" — a binding-backed adapter's conformance suite
// (e.g. D1's, which needs `env.DB` and only exists inside workerd) belongs
// under `test/unit/` for that reason, not as a misfiling.
//
// Forwarding a host env var into a workerd test: this config file runs in
// Node and can read `process.env` directly, but test bodies in the
// `workers` project run inside workerd, where `process.env` holds only a
// handful of Vite-injected keys, never host environment variables. Forward
// the value as a `miniflare: { bindings: { … } }` entry inside the
// `cloudflareTest({ … })` call below — miniflare is an option of that
// plugin, not of the project object or its `test` block — and declare the
// matching field on `Cloudflare.Env` in test/env.d.ts. The
// `node` project needs no such forwarding — its tests run in real Node and
// can read `process.env` directly.
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
        test: {
          name: 'workers',
          include: ['test/unit/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['test/integration/**/*.test.ts'],
          // Vitest's defaults (5s per test, 10s per hook) are sized for
          // CPU-bound unit tests. Every test in this project instead spends
          // its whole budget on sequential round trips to a real database —
          // over HTTPS to a hosted serverless tier, from a CI runner, for the
          // TiDB/Turso/Neon suites.
          //
          // Those defaults were not merely tight, they failed: the tidb
          // conformance suite's concurrent-write case timed out at exactly
          // 5000ms on one CI attempt and passed on a retry of the *same*
          // commit, taking `afterAll` down with it at exactly 10000ms. That
          // case has the least headroom of any test here because it spends up
          // to 2s of its budget on the deliberate starved-pool race below
          // before making three more round trips; its best observed CI time is
          // 971ms, so the default left under 5x margin against a transport
          // whose tail latency is not ours to control.
          //
          // `retry` was deliberately absent here, on the grounds that the
          // assertions never disagreed with the database — they ran out of
          // clock — and that retrying would paper over a genuine intermittent
          // bug in the adapters, which is the one class of defect this suite
          // exists to catch. That reasoning still stands, and every failure
          // this config can only see as a bare timeout is still unretried.
          //
          // What changed is that a stalled request stopped being one of those.
          // `@tidbcloud/serverless` fetches without a signal, so a request that
          // never comes back used to be indistinguishable from a hang: both
          // arrived as `Test timed out in 30000ms` with nothing to attribute
          // them to. Now that the TiDB suite bounds its clients with cf-knex's
          // own `timeoutMs`, a stall instead fails as a CfKnexError naming the
          // budget it blew — and that is a failure the adapters cannot produce
          // by being wrong. A real adapter bug returns the wrong answer, or
          // hangs with no budget to exceed; both still go red on attempt one.
          //
          // So this retry is conditional and matches that one message, nothing
          // else. It exists because the alternative is a `live` job that goes
          // red on TiDB Cloud Serverless stalls no one here can fix (observed
          // 2026-08-06 and 2026-08-10), and a job that cries wolf gets ignored.
          retry: { count: 2, delay: 1_000, condition: /timeoutMs budget/ },
          testTimeout: 30_000,
          // Larger than `testTimeout`, which is not an oversight. A stall in a
          // hook cannot be retried by the option above — vitest retries test
          // bodies only — so test/support/stall.ts carries its own retry for
          // hooks, and this has to be the outer bound of the two: that helper
          // spends up to `RETRY_BUDGET_MS` before it gives up and rethrows the
          // CfKnexError naming the budget. When this was the smaller number,
          // vitest killed the hook first and reported an anonymous `Hook timed
          // out in 30000ms`, discarding that attribution entirely. Imported
          // rather than written out again so the ordering cannot drift.
          hookTimeout: HOOK_TIMEOUT_MS,
        },
      },
      {
        test: {
          name: 'types',
          environment: 'node',
          typecheck: { enabled: true, include: ['test/types/**/*.test-d.ts'] },
          include: ['test/types/**/*.test-d.ts'],
        },
      },
    ],
  },
})
