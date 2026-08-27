import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',       // Knex generics require `any` defaults
      '@typescript-eslint/no-unsafe-function-type': 'off', // driver shapes are structurally typed
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'], // house style: type over interface
      curly: ['error', 'multi-line'], // a brace-less body may not span lines
    },
  },
  {
    // test/env.d.ts augments the ambient `Cloudflare.Env` interface (the type
    // `cloudflare:test`'s `env` export is actually typed against in this pinned
    // @cloudflare/vitest-pool-workers / @cloudflare/workers-types combo) so the
    // `DB` / `HYPERDRIVE_MYSQL` / `HYPERDRIVE_PG` bindings type-check. That
    // requires declaration merging — only `interface` supports that, `type`
    // cannot merge. Scope the house-style rule off for test/** so that file
    // doesn't trip it.
    // Scoped to this one file, not `test/**`: declaration merging is the only
    // reason to reach for `interface` here, and env.d.ts is the only file that
    // needs it. A directory-wide exemption would quietly let the house style
    // lapse across every other test file.
    files: ['test/env.d.ts'],
    rules: {
      '@typescript-eslint/consistent-type-definitions': 'off',
    },
  },
  {
    // Unlike src/ (deliberately free of Node globals — see src/core/client.ts's
    // `StreamSink` comment), scripts/ runs directly under Node via a shebang,
    // so it needs Node's globals recognized rather than flagged as undefined.
    // Listed explicitly (not via the `globals` package) to avoid adding a new
    // dependency just for a handful of well-known identifiers.
    // bench/ is grouped here for the same reason: it runs under
    // `node --env-file=.env`, reads `process.env.TIDB_URL`, and times with
    // `performance.now()`.
    files: ['scripts/**/*.mjs', 'bench/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        performance: 'readonly',
      },
    },
  },
  {
    // test/integration/migrate.test.ts loads these off disk through knex's
    // default `FsMigrations` source. `.cjs` (rather than plain `.js`,
    // ambiguous under this project's own `"type": "module"`) forces
    // CommonJS loading, so `exports.up`/`exports.seed` need the CommonJS
    // globals ESLint's flat config only adds for `sourceType: 'commonjs'`.
    files: ['test/support/fixtures-migrate/**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
  },
)
