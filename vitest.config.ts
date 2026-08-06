import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

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
          // Deliberately not `retry`: the assertions never disagreed with the
          // database, they ran out of clock. Retrying would also paper over a
          // genuine intermittent bug in the adapters, which is the one class
          // of defect this suite exists to catch.
          testTimeout: 30_000,
          hookTimeout: 30_000,
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
