// This project has no `@types/node` dependency — installing it would pull
// in ambient globals (`fetch`, `Response`, `ReadableStream`, ...) that
// collide with `@cloudflare/workers-types`. `@cloudflare/workers-types`
// itself does not ship types for `node:module`, even though `createRequire`
// works at runtime under the `nodejs_compat` compatibility flag (see
// wrangler.jsonc). Declare just the slice `client.ts` uses.
//
// (Ambient module declarations must live in a `.d.ts` file: the same
// `declare module 'node:module'` block written inside client.ts — a file
// with top-level imports — is parsed as an augmentation of an existing
// module rather than a new ambient one, and fails to compile because no
// such module is otherwise known to the type checker.)
declare module 'node:module' {
  export function createRequire(url: string): (id: string) => unknown
}
