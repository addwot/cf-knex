#!/usr/bin/env node
// Builds the package the way a real consumer receives it: packs the
// tarball `npm publish` would ship, installs it into a throwaway project
// alongside wrangler, and runs a genuine `wrangler deploy --dry-run` for
// every published entry point.
//
// This exists because neither test suite in this repo catches a bundling
// defect: vitest-pool-workers and Node's own module resolution both treat
// `require()` as lazy, so a literal `require('some/optional/dep')` buried
// inside a dependency only fails here, where esbuild (via wrangler) walks
// and resolves that call statically at build time regardless of whether
// the branch containing it ever runs.
//
// Not part of `pnpm test` — this shells out to `npm install` and a real
// wrangler build per entry point, which is slow (tens of seconds) compared
// to the rest of this repo's tests. Run it as its own CI step after
// `pnpm build`, gating publish rather than every push.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const WRANGLER_VERSION = '4.119.0'

if (!existsSync(join(repoRoot, 'dist', 'index.js'))) {
  console.error('dist/ not found — run `pnpm build` first.')
  process.exit(1)
}

// One `createClient(...)` call per published entry point, exercising the
// exact `createKnexClient` path each funnels through (see src/core/client.ts).
// The option values don't need to describe a reachable database —
// `wrangler deploy --dry-run` only bundles the Worker, it never calls `fetch`.
const ENTRIES = [
  { name: 'cf-knex', specifier: 'cf-knex', opts: `{ engine: 'sqlite', binding: env.DB }` },
  { name: 'cf-knex/d1', specifier: 'cf-knex/d1', opts: `{ binding: env.DB }` },
  { name: 'cf-knex/turso', specifier: 'cf-knex/turso', opts: `{ url: 'libsql://x', authToken: 'y' }` },
  { name: 'cf-knex/mysql', specifier: 'cf-knex/mysql', opts: `{ url: 'mysql://u:p@h/d' }` },
  { name: 'cf-knex/postgres', specifier: 'cf-knex/postgres', opts: `{ url: 'postgres://u:p@h/d' }` },
  { name: 'cf-knex/tidb', specifier: 'cf-knex/tidb', opts: `{ url: 'https://x' }` },
]

const work = mkdtempSync(join(tmpdir(), 'cf-knex-bundle-check-'))
const results = []

try {
  const tarball = execFileSync('npm', ['pack', '--silent', '--pack-destination', work], { cwd: repoRoot, encoding: 'utf8' }).trim()

  const consumer = join(work, 'consumer')
  mkdirSync(consumer)
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify(
      {
        name: 'cf-knex-bundle-check',
        private: true,
        type: 'module',
        dependencies: { 'cf-knex': `file:../${tarball}`, knex: '3.3.0' },
        devDependencies: { wrangler: WRANGLER_VERSION },
      },
      null,
      2,
    ),
  )
  execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: consumer, stdio: 'pipe' })

  // Load every entry point from the installed tarball, once through `import`
  // and once through `require`, and check the export the README tells people
  // to use is actually there. `publint`/`arethetypeswrong` check the exports
  // map as data; this checks that Node agrees with it, which is a different
  // question — a condition pointing at a file that doesn't exist, or a CJS
  // build whose named exports don't survive the interop, passes the static
  // checks and fails here. No database is involved: loading the module and
  // reading a property never opens a connection.
  for (const entry of ENTRIES) {
    const check = (source, kind) => {
      try {
        execFileSync(process.execPath, ['--input-type=module', '-e', source], { cwd: consumer, stdio: 'pipe' })
        results.push({ entry: `${entry.name} (${kind})`, ok: true })
      } catch (err) {
        results.push({ entry: `${entry.name} (${kind})`, ok: false, output: (err.stdout ?? '') + (err.stderr ?? '') })
      }
    }
    const assertFn = `if (typeof m.createClient !== 'function') { throw new Error('createClient missing from ' + ${JSON.stringify(entry.specifier)}) }`
    check(`const m = await import(${JSON.stringify(entry.specifier)}); ${assertFn}`, 'import')
    check(
      `const { createRequire } = await import('node:module');` +
        `const m = createRequire(process.cwd() + '/x.js')(${JSON.stringify(entry.specifier)}); ${assertFn}`,
      'require',
    )
  }

  mkdirSync(join(consumer, 'src'))

  for (const entry of ENTRIES) {
    writeFileSync(
      join(consumer, 'src', 'worker.ts'),
      [
        `import { createClient } from '${entry.specifier}'`,
        `export default {`,
        `  async fetch(_req: Request, env: any) {`,
        `    const db = createClient(${entry.opts})`,
        `    return Response.json(await db.raw('select 1 as one'))`,
        `  },`,
        `}`,
        '',
      ].join('\n'),
    )
    writeFileSync(
      join(consumer, 'wrangler.jsonc'),
      JSON.stringify(
        {
          name: 'cf-knex-bundle-check',
          main: 'src/worker.ts',
          compatibility_date: '2026-08-01',
          // Required for knex's own use of Node builtins (`events`, `timers`)
          // regardless of this defect — standard for any Worker depending on
          // knex, not a workaround for the bug this script guards.
          compatibility_flags: ['nodejs_compat'],
        },
        null,
        2,
      ),
    )
    const outdir = join(work, 'out', entry.name.replace('/', '-'))
    try {
      execFileSync('npx', ['wrangler', 'deploy', '--dry-run', '--outdir', outdir], { cwd: consumer, encoding: 'utf8' })
      results.push({ entry: entry.name, ok: true })
    } catch (err) {
      results.push({ entry: entry.name, ok: false, output: (err.stdout ?? '') + (err.stderr ?? '') })
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}

let failed = false
for (const result of results) {
  if (result.ok) {
    console.log(`ok    ${result.entry}`)
  } else {
    failed = true
    console.error(`FAIL  ${result.entry}`)
    console.error(result.output)
  }
}

if (failed) {
  console.error('\nOne or more entry points failed to load from the packed tarball, or to bundle under a real `wrangler deploy --dry-run`.')
  process.exit(1)
}
console.log('\nEvery entry point loads from the packed tarball under both `import` and `require`,')
console.log('and bundles cleanly under a real `wrangler deploy --dry-run`.')
