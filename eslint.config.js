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
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-definitions': 'off',
    },
  },
)
