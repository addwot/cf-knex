import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // Test bodies run inside workerd, not Node — process.env there holds
        // only ~7 Vite-injected keys, never host environment variables. This
        // config file itself runs in Node, so it can read process.env and
        // forward the value into the worker as a binding. This is the
        // pattern for any test that needs a live connection URL inside
        // workerd. Not consumed by any test today (the mysql2-based spike
        // that used it was removed — see
        // docs/superpowers/notes/2026-08-04-workerd-spike.md — because
        // mysql2 cannot be loaded inside this test pool at all, a tooling
        // limitation, not a product one). Left in place for Tasks 7-11,
        // which need this exact pattern for their own live-connection tests.
        //
        // The fallback is `''`, NOT a hardcoded local URL. Spec §5.3
        // requires that an absent connection URL make a conformance test
        // skip with a printed notice, never silently pass or attempt a real
        // connection. `env.MYSQL_URL` presence-checking (`if (!env.MYSQL_URL)
        // skip(...)`) is that skip signal for every later task's tests
        // (Tasks 7-11) — a non-empty default here would make the check
        // always truthy and defeat it, turning "no container running" into
        // a confusing ECONNREFUSED instead of an honest skip. To run these
        // tests locally, set MYSQL_URL yourself (see
        // docs/superpowers/notes/2026-08-04-workerd-spike.md's "Notes on
        // running tests going forward" for how).
        bindings: {
          MYSQL_URL: process.env.MYSQL_URL ?? '',
        },
      },
    }),
  ],
  test: { include: ['test/**/*.test.ts'] },
})
