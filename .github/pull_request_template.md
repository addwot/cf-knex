<!--
Thanks for sending this. Delete whatever does not apply — the sections below are
prompts, not a form to fill in completely.

CONTRIBUTING.md has the details: https://github.com/addwot/cf-knex/blob/master/CONTRIBUTING.md
-->

## What this changes

<!-- One or two sentences. If it fixes an issue, write "Closes #123". -->

## Why

<!--
The reasoning, not the diff — the diff is right there. If a backend behaves in a way
that forced your hand, say which backend and what it did.
-->

## How it was verified

<!--
Which suites you ran, and against what. `pnpm test` alone is fine for changes that do
not touch a driver; say so. If you tested against a hosted tier (TiDB Serverless, Neon,
Turso) mention it — CI will not do that for you on a pull request.
-->

## Checklist

- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm check:package` passes locally
- [ ] A behaviour difference between backends is pinned by a test, not only described in the README
- [ ] `pnpm changeset` was run, **or** this PR changes nothing about the published package (docs, tests or CI only)
- [ ] No connection string, password or auth token appears anywhere in the diff — including in test fixtures and error-message expectations

<!--
Two things worth knowing before you wait on CI:

- The `live` job does not run on pull requests. It exercises the hosted tiers, whose
  credentials are repository secrets, and it runs on `master` after merge instead. Your
  PR being green does not mean TiDB Serverless, Neon or Turso were touched.
- If you are pushing from a fork, the workflows wait for a maintainer to approve the
  run. Nothing is wrong; it just needs a human first.
-->
