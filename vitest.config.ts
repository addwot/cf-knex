import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

// Two projects, because @cloudflare/vitest-pool-workers cannot import
// `mysql2` or `pg` at all — both are CJS packages with dual ESM/CJS exports
// maps and bare Node-builtin requires the pool's module loader can't
// resolve. `workers` runs inside workerd for anything that must be proven
// to work there; `node` runs in plain Node for real TCP driver tests.
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
        },
      },
    ],
  },
})
