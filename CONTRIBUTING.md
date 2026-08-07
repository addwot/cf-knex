# Contributing

Issues and pull requests are welcome. This file covers the things that are specific to
this project — the ones you would otherwise discover by having CI reject you.

## Before you open an issue

Check the guide's [Things that will surprise
you](https://github.com/addwot/cf-knex/blob/master/examples/README.md#things-that-will-surprise-you)
first. Several of
the most surprising behaviours are deliberate and already documented: aggregates come back
as strings on most backends, `insertId` is a bigint on TiDB, and a backend that cannot do
something raises a typed `CfKnexError` rather than pretending it can.

**Never paste a connection string, password or auth token into an issue.** cf-knex
redacts credentials from its own error messages, but a driver's error or a stack trace can
still carry one. Replace them with `***`. For a security vulnerability, use [private
reporting](https://github.com/addwot/cf-knex/security/advisories/new) instead of a public
issue.

## Setting up

Node 22 or newer. The pinned package manager is pnpm 11.20.0; if your global pnpm is
older it cannot install it, so prefix commands with `corepack`.

```sh
corepack pnpm install
cp .env.example .env
docker compose up -d      # mysql, mariadb, postgres, libsql
corepack pnpm test
```

`.env.example` ships with working values for everything docker-compose provides. The four
hosted tiers (TiDB Serverless, Neon, Turso) are commented out because they are real
accounts. Leave them unset: every suite gated on a missing variable registers a named
`test.skip` placeholder that says which variable was absent, so `pnpm test` is green
without them. You do not need a TiDB account to contribute.

## Where a test goes

The directory is chosen by the *runtime a test needs*, not by what kind of test it is.

- `test/unit/**` runs **inside workerd** via `@cloudflare/vitest-pool-workers`. D1's
  conformance suite lives here despite being an integration test, because `env.DB` only
  exists in workerd.
- `test/integration/**` runs in **plain Node**. `mysql2` and `pg` cannot be imported
  inside the workers pool at all, so their suites have to live here.
- `test/types/**` is typechecked by `tsc` *and* executed.

A difference between backends gets an assertion, not just a README sentence. That rule is
why the guide's compatibility notes can be trusted: each one has a test behind it.

## Conventions the linter and reviewer will hold you to

- **`type`, not `interface`.** eslint enforces this. The only exemption is
  `test/env.d.ts`, which needs declaration merging.
- **Redact before logging.** Any URL that can reach an error message or a log goes
  through `redact()` in `src/core/infer.ts` first.
- **No credentials in a committed file, ever.** `.gitignore` covers `.env*` by prefix.
  gitleaks scans the whole history on every pull request and blocks the merge, so a
  credential committed and then removed still fails — it has to be scrubbed from history.
- **Adding an adapter means adding its entry point too**: `src/entries/<name>.ts`, the
  matching `exports` and `typesVersions` blocks in `package.json`, and its rows in
  `.size-limit.json`. The subpath entries exist so a Worker bundles one adapter instead of
  five; an adapter reachable only from the barrel silently costs every user bytes.

Branches use the conventional-commit type as a prefix — `feature/`, `fix/`, `docs/`,
`test/`, `ci/`, `chore/`, `refactor/`. Nothing in CI keys off it; it is there so the
branch list reads like the changelog. Commit subjects follow the same vocabulary and
explain *why*.

## Changesets

Any pull request that changes the published package adds one:

```sh
corepack pnpm changeset
```

Pick `patch`, `minor` or `major` and write the description for someone reading the
CHANGELOG on npm, not for a reviewer reading the diff. Docs-only, test-only and CI-only
pull requests need no changeset.

Releases are trunk-based: merging to `master` opens a "chore: version packages" pull
request that applies every pending changeset; merging *that* publishes to npm with
provenance and pushes the tag. There is no release branch.

## What happens to your pull request

Required checks are `static`, `gitleaks`, `test (3.1.0)` and `test (3.3.0)` — the test
job runs the whole suite against both supported Knex.js versions. Run this before pushing
and you will usually match them:

```sh
corepack pnpm lint && corepack pnpm typecheck && corepack pnpm test \
  && corepack pnpm build && corepack pnpm check:package
```

Two things that are easy to misread:

- **The `live` job does not run on pull requests.** It exercises the hosted tiers using
  repository secrets, which a forked pull request cannot see anyway, and which cost quota
  on every push. It runs on `master` after merge instead. A green pull request means the
  local backends passed, not that TiDB Serverless or Neon were touched.
- **Forked pull requests wait for a maintainer to approve the workflow run.** That is a
  setting on the repository, not a problem with your branch.

Merging is done by a maintainer. Everything reaches `master` through a pull request with
its checks green — the branch rules apply to maintainers too, so a red check blocks the
merge for everyone.

## License

By contributing you agree that your contribution is licensed under the MIT license, the
same as the rest of the project.
