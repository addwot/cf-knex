// knex ships types only for its public entry point; the dialect classes
// below live at deep CJS paths (`knex/lib/dialects/*`) that carry no
// declarations of their own. Each default export is treated as an unknown
// constructor — exactly what `createKnexClient`'s runtime
// `typeof Base !== 'function'` guard checks before subclassing it.
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
