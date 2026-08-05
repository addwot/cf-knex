// `pg` ships no type declarations of its own (no `types`/`typings` field, no
// `.d.ts` anywhere in the package) and this repo does not depend on
// `@types/pg`. Declare only the shape the node project's smoke test
// actually touches — a default export exposing a `Client` constructor —
// the same narrow, non-`any` pattern used for knex's untyped dialect
// requires in src/core/knex-dialects.d.ts.
declare module 'pg' {
  const pg: { Client: new (...args: never[]) => unknown }
  export default pg
}
