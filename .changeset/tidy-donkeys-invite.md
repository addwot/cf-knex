---
'cf-knex': minor
---

Add `timeoutMs` and `fetch` to the TiDB Cloud Serverless HTTP driver.

`@tidbcloud/serverless` calls `fetch` with no signal, no timeout and no retry, and cf-knex
gave you no way to wrap it — so a request that stalled stalled forever, and a Worker
waited until the platform killed it. Seen in practice: a statement that normally takes
~1s hung past 30s against an otherwise healthy cluster, while every other statement in
the same run kept its usual timing.

`timeoutMs` bounds each request and raises `CfKnexError` with the new `REQUEST_TIMEOUT`
code. It is opt-in and has no default, because the abort is local: a statement that times
out may still be applied server-side, so the error means unknown outcome, not "did not
happen". The signal is both passed to `fetch` and raced, so the bound holds even for a
`fetch` that ignores signals.

`fetch` replaces the one handed to the driver, for retries, tracing, or a more specific
bound. `timeoutMs` composes on top of it. Both are available on `cf-knex/tidb`'s
`createClient` and on the root `createClient`'s `ClientConfig`. Nothing changes for a
client that sets neither, which is handed the same unwrapped `fetch` as before.
