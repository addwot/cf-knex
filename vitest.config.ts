import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // Why this binding exists: test bodies run inside workerd, not
        // Node, and process.env there holds only ~7 Vite-injected keys —
        // never host environment variables. This config file itself runs
        // in Node, so it can read process.env and forward the value into
        // the worker as a binding. This is the required pattern for any
        // test that needs a live connection URL inside workerd (Tasks
        // 7-11 will reuse it).
        //
        // Why the fallback is `''`, not a URL: spec §5.3 requires that an
        // absent connection URL make a conformance test skip with a
        // printed notice, never silently pass or attempt a real
        // connection. `if (!env.MYSQL_URL) skip(...)` is that skip signal
        // — a non-empty default here would make the check always truthy
        // and defeat it, turning "no container running" into a confusing
        // ECONNREFUSED instead of an honest skip.
        //
        // How to run tests that consume this locally: export the var in
        // your shell before invoking vitest, e.g.
        //   cp .env.example .env && export $(grep -v '^#' .env | xargs) && pnpm test
        // or set it inline per invocation:
        //   MYSQL_URL=mysql://root:root@127.0.0.1:3306/cf_knex_test pnpm test
        // (No .env auto-loading is wired up on purpose — not a dependency
        // decision to make silently. Internal working notes, not in this
        // repo, have the fuller rationale if you go looking for it and it's
        // gone.)
        //
        // Known limitation: @cloudflare/vitest-pool-workers cannot import
        // `mysql2` or `pg` at all — both are CJS packages with dual
        // ESM/CJS exports maps and bare Node-builtin requires this pool's
        // module loader can't resolve. Live driver tests against those two
        // need a separate vitest project with `environment: 'node'`, not
        // this workerd pool. Don't assume this pool can exercise a real
        // driver — it can't, and the failure mode if you try is confusing.
        bindings: {
          MYSQL_URL: process.env.MYSQL_URL ?? '',
        },
      },
    }),
  ],
  test: { include: ['test/**/*.test.ts'] },
})
