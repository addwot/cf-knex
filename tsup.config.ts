import { defineConfig } from 'tsup'

// Every peer dependency stays external — a dynamic `await import('pg')`
// (as every adapter uses) does not keep esbuild from inlining it on its own:
// measured on this exact code, dropping this list ballooned dist/pg.js from
// 594 bytes to 1.5 MB. `'knex'` alone is enough to cover every
// `knex/lib/dialects/*` deep import too (all four resolve to the same
// package name), so no separate wildcard entry is needed for those.
const EXTERNAL = ['knex', 'mysql2', 'mysql2/promise', 'pg', '@tidbcloud/serverless', '@libsql/client']

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    mysql: 'src/entries/mysql.ts',
    postgres: 'src/entries/postgres.ts',
    tidb: 'src/entries/tidb.ts',
    d1: 'src/entries/d1.ts',
    turso: 'src/entries/turso.ts',
  },
  format: ['esm', 'cjs'],
  target: 'es2022',
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  external: EXTERNAL,
})
