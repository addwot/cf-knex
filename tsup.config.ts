import { defineConfig } from 'tsup'

// tsup already externalizes everything listed in package.json's
// `peerDependencies` (node_modules/tsup/dist/chunk-VGC3FXLU.js reads
// `data.peerDependencies` directly), so on the current package.json this
// list is redundant with that default — verified by rebuilding with
// `external: []`: every entry's output, and every shared chunk, comes out
// byte-for-byte equivalent, and no driver-package internals (e.g. pg's own
// error classes) appear inlined anywhere. Kept explicit anyway, not for
// today's build but as a guard against tomorrow's: this list stays correct
// even if a driver dependency is ever demoted out of `peerDependencies`
// (a `dependencies`-only entry esbuild would otherwise be free to inline)
// without this file being touched in the same change. `'knex'` alone also
// covers every `knex/lib/dialects/*` deep import (all resolve to the same
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
  // Sourcemaps stay on — a consumer's stack trace should still be able to
  // point at the right src/ line — but `sourcesContent` (esbuild's default)
  // embeds the full text of every src/ file being mapped inside each .map,
  // not just the mapping table. Measured on this exact build:
  // `npm pack --dry-run --json` reports 1,034,446 unpacked bytes total, of
  // which 729,050 (70.5%) is `.map` files, and every `.map` in dist/ has a
  // non-empty `sourcesContent` array (checked directly, not assumed). None
  // of that source text is needed to resolve a stack trace back to a
  // src/ line/column — only the mappings are — so turning it off cuts the
  // package's dominant cost with no loss to what sourcemaps are for here.
  esbuildOptions(options) {
    options.sourcesContent = false
  },
})
