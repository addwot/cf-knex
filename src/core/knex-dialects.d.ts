// knex ships types only for its public entry point (`knex` / `import type
// { Knex } from 'knex'`) — the dialect classes, and internals like the
// logger, live at deep CJS paths (`knex/lib/*`) that carry no declarations.
// `client.ts` statically imports these paths directly (not via
// `createRequire`) so Vite can see them in its module graph and bundle
// their dependencies — notably `colorette`, which knex's logger needs —
// correctly; see the comment above `DIALECT_CLASSES` in client.ts for why
// that matters. This file supplies just enough type surface for that: each
// dialect path's default export is treated as an unknown constructor,
// exactly what `createKnexClient`'s runtime `typeof Base !== 'function'`
// guard checks before subclassing it.
declare module 'knex/lib/dialects/mysql2' {
  const Client_MySQL2: new (...args: never[]) => unknown
  export default Client_MySQL2
}

declare module 'knex/lib/dialects/postgres' {
  const Client_PG: new (...args: never[]) => unknown
  export default Client_PG
}

declare module 'knex/lib/dialects/sqlite3' {
  const Client_SQLite3: new (...args: never[]) => unknown
  export default Client_SQLite3
}

// client.ts also imports this path for its side effect (putting `colorette`
// in Vite's module graph — see the comment above `DIALECT_CLASSES` there);
// nothing imports its export, so no type surface is needed beyond letting
// the bare `import 'knex/lib/logger'` resolve.
declare module 'knex/lib/logger'
