# cf-knex

A Knex.js-syntax database connector for Cloudflare Workers: TiDB Cloud Serverless, MySQL,
Postgres, D1 and Turso, direct or via Hyperdrive. Published to npm as `cf-knex`, MIT,
public repo `addwot/cf-knex`, default branch `master`.

## Where to look

Read the row before exploring. Most questions about this repo are already answered
somewhere, and the answer is usually in a file rather than in the source.

| When you need | Read |
|---|---|
| Which vitest project a test belongs in | `CONTRIBUTING.md` § Where a test goes |
| Changesets, required checks, what happens to a PR | `CONTRIBUTING.md` |
| Per-backend behaviour, configuration, error codes, lifetime | `examples/README.md` — the guide; every reference section lives there |
| What a first-time user sees | `README.md` — a landing page, deliberately thin |
| The contract an adapter implements | The `DriverAdapter` doc comment in `src/core/types.ts` |
| A model to copy when writing an adapter | `src/adapters/d1.ts` (smallest complete one); `src/adapters/tidb-http.ts` for transaction nuance |
| How Knex.js expects a driver to answer | `node_modules/knex/lib/dialects/{mysql,postgres,sqlite3}/index.js` |
| What a driver package actually does | Its installed `dist/` — e.g. `node_modules/@tidbcloud/serverless/dist/index.js` |
| CI jobs, gating, secrets | `.github/workflows/ci.yml` |
| Published entry points and their budgets | `package.json` `exports` + `.size-limit.json` |

## Commands

| | |
|---|---|
| `pnpm test` | all three vitest projects |
| `pnpm test:unit` | `test/unit/**` — runs **inside workerd** |
| `pnpm test:integration` | `test/integration/**` — runs in **plain Node** |
| `pnpm test:types` | `test/types/**` — `tsc` *and* runtime execution |
| `pnpm typecheck` / `pnpm lint` / `pnpm build` | |
| `pnpm size` | size-limit, per entry point |
| `pnpm check:package` | publint + arethetypeswrong on the built package |
| `pnpm check:examples` | typechecks `examples/*` against the fresh build |
| `pnpm verify:bundle` | packs the publish tarball, installs it into a throwaway project and runs a real `wrangler deploy --dry-run` per entry point. Slow, so it is not in `pnpm test`; it is what catches a lazy `require()` inside a dependency that neither suite can |
| `pnpm bench:tidb` | cf-knex vs raw `@tidbcloud/serverless`, needs `TIDB_URL` |
| `docker compose up -d` | mysql, mariadb, postgres, libsql for the local suites |

The global `pnpm` on this machine is v10 and cannot install the pinned `packageManager`
(pnpm 11.20.0). Prefix with `corepack` — `corepack pnpm test` — or `npm i -g pnpm@11.20.0`
once.

Local integration suites read `.env` (copy `.env.example`). `vitest.config.ts` loads it via
`process.loadEnvFile` — keep that: the `node` project reads `process.env`, and miniflare's
"Using secrets defined in .env" line covers the `workers` project only. Already-set
variables win, so CI's secrets are never shadowed. **Never `source .env`** — a value
contains an unquoted `&` that the shell reads as a job separator and silently drops;
`node --env-file=.env` parses it correctly.

Any suite whose credential is unset registers a named `test.skip` placeholder rather than
failing, so `pnpm test` is green without the hosted tiers. CI asserts the hosted suites
actually ran. Locally, check the file count: 30/30 means the backends were reached, 24/30
means six suites skipped wholesale.

## Layout

- `src/adapters/*` — one per driver: `d1`, `libsql`, `mysql2`, `pg`, `tidb-http`. Each is
  `type <Name>AdapterOptions` plus `create<Name>Adapter(opts): DriverAdapter`, nothing else.
- `src/core/` — `client.ts` (Knex.js client + pool + streaming), `infer.ts` (URL → driver,
  and `redact()`), `errors.ts` (`CfKnexError` and its closed `code` union), `response.ts`
  (the one place Knex.js's three response contracts live), `types.ts` (`DriverAdapter` and
  its contract), `disposable.ts` (the `await using` types).
- `src/index.ts` — the barrel. `buildAdapter`'s switch references all five factories, so
  this entry is ~7.1 kB and cannot be tree-shaken below that.
- `src/entries/*` — the per-database subpath exports (`cf-knex/tidb`, `/d1`, `/mysql`,
  `/postgres`, `/turso`), ~3.3–4.3 kB each. They exist so a Worker bundles one adapter.

**Engine vs driver.** `Engine` is `'mysql' | 'postgres' | 'sqlite'` — there is no `'tidb'`
engine. TiDB over HTTP is `{ engine: 'mysql', driver: 'tidb-http' }`.

**Adding an adapter is four edits, not one:** `src/adapters/<name>.ts`,
`src/entries/<name>.ts`, the `exports` and `typesVersions` blocks in `package.json`, and
the rows in `.size-limit.json`. An adapter reachable only from the barrel costs every user
bytes.

## Rules

**No credentials in any committed file, ever.** `.gitignore` covers `.env*` by prefix (not
by exact name — an ad-hoc `.env.bak-…` once sat untracked-but-unignored). gitleaks scans
the full history on every PR and gates merge, so a credential committed and then deleted
still fails; it has to be scrubbed from history.

**A secret must never reach an error message or a log.** `infer.ts` routes its throw paths
through the module-private `redact()`. `redact()` is not exported: outside `infer.ts` the
rule is met by keeping the secret out of the message entirely — `tidb-http.ts` names the
*kind* of statement that failed and never the SQL, and never prints a session token. If
new code genuinely needs the masking, export `redact()` deliberately rather than
hand-rolling a second one.

**Never assume library internals — read the installed source.** This project has been wrong
about `@tidbcloud/serverless`'s transaction model, Knex.js's dialect hooks and changesets'
tag format, each time by reasoning instead of reading. Read the installed `dist/` or `lib/`
before writing the line, and put the citation where a reviewer will see it — the commit
message, the PR, or `examples/README.md`. Not in a source comment; see the next rule.

**`src/` carries almost no comments.** The names and the signatures are the documentation.
All 828 comments were deleted in one pass on 2026-08-27, taking `src/` from 3,096 lines to
1,550 and from 104,873 comment characters to 3,943; six one-sentence comments were then
added back. Assume the file you are editing needs none.

A comment earns its place only where the code *cannot* say the thing, which in practice is
two shapes and no others:

- a **magic constant** whose meaning lives in someone else's spec — `'25P01'` in `pg.ts` is
  postgres for "no active transaction", and nothing on that line can say so.
- a **deliberate absence** — `pg.ts` never issues `RELEASE SAVEPOINT`, and `mysql2.ts` calls
  `query()` and never `execute()`. Absence is invisible by construction, so it is the one
  thing a reader cannot re-derive no matter how good the names are.

One sentence, on the line above, wrapped at ~100. Not a paragraph, not a citation block, not
a restatement of the next line. The six that exist are the whole set worth having; if you
believe a seventh is needed, it is more likely the code should change instead.

Everything else that used to be commented — the tarn and knex citations, the dated
incidents, the measured numbers — goes in `examples/README.md`, in this file's *Facts worth
not rediscovering*, or in the commit message.

Two more exceptions, neither of them prose:

- **`eslint-disable` directives**, which keep their `--` justification. eslint needs the
  directive on one line, and the justification is what makes it reviewable.
- **JSDoc on a symbol the package actually publishes** — today exactly `fromEnv`,
  `DriverAdapter`, `DisposableKnex` and `DisposableTransaction`. tsup emits JSDoc into
  `dist/*.d.ts` and a consumer's editor shows nothing else on hover. *Published* means the
  name appears in an `export {…}` of a built `dist/*.d.ts`, which is narrower than saying
  `export` in the source: `resolveConfig`, `createLibsqlAdapter` and `LibsqlAdapterOptions`
  all say `export` and none of them reach a consumer.

**Prefer putting the knowledge in code over commenting it.** Most of what survived the strip
survived because it was never prose: `CfKnexError.commitSilentlyRolledBack`'s message
explains the whole aborted-transaction situation to whoever hits it, `poolTimedOutMessage`
diagnoses an un-awaited transaction in four sentences, and `settleWithin` needs no comment
because of its name. A backend divergence gets a test, per the rule below — not a sentence.

**Stripping comments must not touch code.** A `//` inside a template literal
(`'${scheme}://'`) or a regex (`/:\/\//`) is not a comment, and TypeScript's bare
`createScanner` will report it as one — a run of exactly that silently truncated two lines
of `infer.ts`, caught only by the next `pnpm lint`. Use the parser instead
(`ts.createSourceFile` with `setParentNodes`, then `getLeadingCommentRanges` /
`getTrailingCommentRanges` over leaf tokens), and prove the edit by comparing the token
stream before and after — skipping kinds `FirstJSDocNode`..`LastJSDocNode`, since the parser
models JSDoc as AST nodes and their removal would otherwise read as a code change. Identical
token streams mean only trivia moved.

**Every `eslint-disable` carries a `--` justification.** All of them do today; keep it that
way. `@typescript-eslint/no-explicit-any` is deliberately **off** — Knex.js's generics need
`any` defaults — so `any` is permitted where the Knex.js surface forces it and avoided
everywhere else.

**`type`, not `interface`** — enforced by eslint. The single exemption is `test/env.d.ts`,
which needs declaration merging.

**Braces on any body that spans lines** — `curly: ['error', 'multi-line']`, enforced by
eslint. Deliberately not `'all'`: the one-line guard clause (`if (!x) return`) is idiomatic
throughout `src/` and there are 61 of them, so `'all'` would mean 62 violations against 1.
`eslint --fix` braces a wrapped `throw` as `{throw …}` on the wrong lines; there is no
prettier in this repo, so fix that one by hand.

**Errors are static factories on `CfKnexError`** with a code from the closed
`CfKnexErrorCode` union, so callers can branch on `err.code` once. Add a code to the union
rather than overloading an existing one, and document it in the guide's error table
(`examples/README.md`). The one bare `Error` in `src/` — `'The query is empty'` in
`client.ts` — is deliberate: it reproduces the message *and* the synchronous-throw shape of
the stock dialects it replaces, which knex's own `ensureConnectionStreamCallback` already
catches. Match an upstream error exactly or raise a `CfKnexError`; do not invent a third
kind.

**A divergence between backends gets a test, not a README sentence alone.** TiDB returns
`insertId` as a bigint and `COUNT` as a decimal string where mysql2 gives numbers; both are
pinned by assertions in `test/integration/tidb.test.ts`. That rule is why the guide's
compatibility notes can be trusted — each one has a test behind it.

**Prefer a compile-time failure to a silent one.** New members of a closed union get an
exhaustiveness guard (`const _exhaustive: never = x`), as in `response.ts`, so growing the
union breaks the build instead of falling through to a wrong branch.

**In prose, the query builder is "Knex.js".** Lowercase `knex` in code font is the npm
package or an identifier. Applies to README, guide, examples and the package description.

**The hosted tiers are real databases.** `TIDB_URL`, `TIDB_URL_2`, `TURSO_URL`, `NEON_URL`
point at live clusters on free plans. Never run destructive or bulk SQL against them
outside the suites that own their fixtures, keep `bench:tidb` sequential and in the low
hundreds of statements, and never paste a secret's value into a transcript.

**Knowledge goes in a committed file.** `README.md` for the landing page, `examples/README.md`
for every reference section, `CONTRIBUTING.md` for process, this file for what an agent
needs each session. `docs/superpowers/` and `.superpowers/` are git-ignored working notes:
never commit them, never cite them in a commit message, and never write a source comment
that delegates its explanation to one — a committed comment must stand alone.

**Correct this file rather than the session.** A rule worth stating twice belongs here, not
in a reply that is lost when the context ends.

## Facts worth not rediscovering

- **Hyperdrive cannot front TiDB Cloud Serverless.** Config creation fails with "Hyperdrive
  does not currently support MySQL AuthSwitchRequest messages" (observed 2026-08-06). TiDB
  Dedicated and self-hosted TiDB are fine — they are ordinary MySQL origins.
- **Hyperdrive does not support MySQL `COM_STMT_PREPARE`.** The mysql2 adapter calls
  `conn.query()`, never `.execute()`, which is why it works. Do not "optimise" that into
  prepared statements.
- **`@tidbcloud/serverless` sets no timeout and no retry.** `postQuery` in its `dist/` calls
  `fetch` with no `signal`, so before `timeoutMs` existed nothing in the stack could end a
  stalled request. That is what a green-then-red CI pair on identical code turned out to be
  (2026-08-07): one statement hung past 30 s while every other statement in the same run
  kept its usual timing, so the cluster was healthy and a single request simply never
  returned. `timeoutMs` both passes an `AbortSignal` *and* races it — passing alone only
  bounds a `fetch` that honours signals, and a caller's own wrapper need not.
- **TiDB Cloud Serverless shares one server-side session** across all stateless connections
  for a credential. `TIDB_URL_2` is a *second* cluster under different credentials, read
  only by the cross-credential isolation suite, which pins that the sharing stops at the
  credential boundary.
- **A `dist` hash cannot prove a change is comments-only.** tsup emits JSDoc into
  `dist/*.d.ts`, and chunk filenames are content-hashed, so one comment edit renames chunks
  and rewrites every import path — the ESM entries then differ for no semantic reason. The
  six `.cjs` entry bundles are *not* code-split, so they are the honest check: build `HEAD`
  in a detached worktree, strip comment lines from each `.cjs` on both sides, and compare.
  Run `node_modules/.bin/tsup` directly there — `pnpm build` first runs a dependency check
  that tries to *purge* a symlinked `node_modules`, and only a missing TTY stops it.
- **Aggregate return types differ per backend** — `count` is a string on `tidb-http` and
  `pg`, a number on `mysql2` and `libsql`; `sum`/`avg` are strings everywhere except libsql;
  `max`/`min` are always numbers. The table in `examples/README.md` is measured output.

## Branches, commits, releases

Everything reaches `master` through a pull request; no direct pushes. Branch prefixes are
the conventional-commit type of the *deliverable* — `feature/`, `fix/`, `docs/`, `test/`,
`ci/`, `chore/`, `refactor/`. Nothing in CI keys off the prefix. A branch adding tests for
existing behaviour is `test/`; one adding a feature and its tests is `feature/`.

Commit subjects use the same vocabulary, imperative mood, and explain *why*. **Backticks in
a commit message need `git commit -F <file>`**, not `-m "…"`.

Any PR that changes published behaviour adds a changeset (`corepack pnpm changeset`),
written for the CHANGELOG reader rather than the diff reviewer. Docs-only, test-only and
CI-only PRs need none. Releases are trunk-based: merging to `master` opens a "chore: version
packages" PR; merging *that* publishes. Publishing uses **npm trusted publishing** (OIDC,
provenance on) — there is no npm token in the repo and none should be added. The `live` job
never runs on pull requests, so a PR is green without touching a hosted tier.

## Before opening a PR

```sh
corepack pnpm lint && corepack pnpm typecheck && corepack pnpm test && corepack pnpm build && corepack pnpm check:package
```

Then confirm `git status` is clean of `.env*` and anything under the ignored notes paths.
