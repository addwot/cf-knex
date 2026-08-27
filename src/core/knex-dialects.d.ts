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

declare module 'knex/lib/knex-builder/make-knex.js' {
  const makeKnex: (client: unknown) => unknown
  export default makeKnex
}
