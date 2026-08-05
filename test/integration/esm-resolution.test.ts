import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

// knex ships no package.json `exports` map, so plain Node ESM refuses a bare
// directory import of its dialect paths (ERR_UNSUPPORTED_DIR_IMPORT) even
// though require() and every bundler resolve them fine either way — only a
// trailing `/index.js` makes `import()` resolve them too. Reads the actual
// source text rather than hardcoding the specifier list, so a future revert
// of src/core/client.ts's import lines fails this test, not just an
// out-of-band note.
//
// The resolution check below shells out to a real `node` process instead of
// calling `import()` in-process: vitest's own module runner resolves a bare
// directory import like `knex/lib/dialects/mysql2` just fine (it does not
// reproduce Node's stricter native ESM resolver), so an in-process
// `import()` here would pass even on the exact specifiers this guard exists
// to reject. Only a real, unmodified `node --input-type=module` process
// reproduces the failure a real consumer hits.
const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const clientSource = readFileSync(`${repoRoot}src/core/client.ts`, 'utf8')
const specifiers = [...clientSource.matchAll(/from '(knex\/lib\/dialects\/[^']+)'/g)].map((m) => m[1])

test('src/core/client.ts imports at least the three known dialect specifiers', () => {
  expect(specifiers).toEqual(
    expect.arrayContaining(['knex/lib/dialects/mysql2/index.js', 'knex/lib/dialects/postgres/index.js', 'knex/lib/dialects/sqlite3/index.js']),
  )
})

test.each(specifiers)('%s resolves under a real Node ESM import()', (specifier) => {
  expect(() =>
    execFileSync(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(specifier)})`], { cwd: repoRoot }),
  ).not.toThrow()
})
