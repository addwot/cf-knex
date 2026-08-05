// This project deliberately carries no @types/node dependency (see
// test/process.d.ts) — declare only the shape
// test/integration/esm-resolution.test.ts actually calls, the same narrow
// shim-over-untyped-import pattern test/pg.d.ts and
// src/core/knex-dialects.d.ts use for other untyped imports.
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: string): string
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string
}

declare module 'node:child_process' {
  export function execFileSync(command: string, args: string[], options: { cwd: string }): unknown
}
