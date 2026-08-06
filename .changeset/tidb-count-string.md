---
"cf-knex": patch
---

Document that TiDB Cloud Serverless returns `COUNT` as a decimal string.

Its HTTP driver encodes aggregate results as strings, so `count('* as count')` yields `'2'` where the same query over the MySQL wire protocol yields `2`. Verified live against both. The failure is quiet — `count > 10` compares strings and `count === 0` is never true — so it is now in the divergences section of the README alongside `insertId`, and pinned by a test rather than hidden behind the `Number()` coercion the conformance suite already used.

Also adds join coverage for the TiDB HTTP adapter: aliased inner joins, `LEFT JOIN` producing `null` (not a missing key) for unmatched rows, joins inside a transaction seeing that transaction's own uncommitted rows and losing them on rollback, grouped counts over a join, and the fact that `select('*')` across a join silently collapses duplicate column names with the last table winning.
