// knex ships types only for its public entry point; the dialect classes
// below live at deep CJS paths (`knex/lib/dialects/*`) that carry no
// declarations of their own. Each default export is treated as an unknown
// constructor — exactly what `createKnexClient`'s runtime
// `typeof Base !== 'function'` guard checks before subclassing it.
declare module 'knex/lib/dialects/mysql2/index.js' {
  const Client_MySQL2: new (...args: never[]) => unknown
  export default Client_MySQL2
}

declare module 'knex/lib/dialects/postgres/index.js' {
  const Client_PG: new (...args: never[]) => unknown
  export default Client_PG
}

declare module 'knex/lib/dialects/sqlite3/index.js' {
  const Client_SQLite3: new (...args: never[]) => unknown
  export default Client_SQLite3
}

// `knex`'s main entry (`knex/lib/knex-builder/Knex.js`) resolves a client
// class from a config's `client`/`dialect` string via
// `knex/lib/knex-builder/internal/config-resolver.js`, which imports
// `knex/lib/dialects/index.js` at module scope purely to make that lookup
// possible — a static import a bundler must follow regardless of which
// branch runs, since `client.ts` always passes a class, never a string.
// That file is a frozen map of literal `require()` calls for all twelve
// knex dialects, several of which (e.g. `mariadb/callback`) are not
// neutralised by knex's `browser` field and fail to resolve entirely in a
// Worker build. `make-knex.js` is the one piece of the factory that
// actually turns a client instance into a callable `knex()` — reachable
// without ever importing `Knex.js` or `config-resolver.js`.
declare module 'knex/lib/knex-builder/make-knex.js' {
  const makeKnex: (client: unknown) => unknown
  export default makeKnex
}
