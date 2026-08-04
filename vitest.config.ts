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
        bindings: {
          MYSQL_URL: process.env.MYSQL_URL ?? 'mysql://root:root@127.0.0.1:3306/cf_knex_test',
        },
      },
    }),
  ],
  test: { include: ['test/**/*.test.ts'] },
})
