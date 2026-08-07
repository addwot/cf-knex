---
'cf-knex': patch
---

Serialise statements issued in parallel inside one TiDB Cloud Serverless transaction.

A transaction is a single server-side session, and a session runs one statement at a
time — `@tidbcloud/serverless` documents this, and parallel statements surfaced as
`Rollback transaction fail: invalid connection`
([serverless-js#61](https://github.com/tidbcloud/serverless-js/issues/61), closed by its
maintainers as "run the transaction serially"). Knex.js does not serialise them, so
`await Promise.all([trx('a').insert(…), trx('b').insert(…)])` — ordinary code that works
on every other backend cf-knex supports — could corrupt the session.

The `tidb-http` adapter now queues in-transaction statements per handle, giving each
transaction a concurrency of one. Statements outside a transaction are unaffected and
stay parallel.

This also makes the `TRANSACTION_ESCAPED` detector sound. It compares the session token
left by a statement's own response, so a concurrent sibling could overwrite that token
mid-check — letting it both miss a real escape and report one for a statement that never
escaped.
