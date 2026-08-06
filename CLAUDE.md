# cf-knex

A knex-syntax database connector for Cloudflare Workers: TiDB Cloud Serverless, MySQL,
Postgres, D1 and Turso, direct or via Hyperdrive. Published to npm as `cf-knex`, MIT,
public repo `addwot/cf-knex`, default branch `master`.

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
| `pnpm bench:tidb` | cf-knex vs raw `@tidbcloud/serverless`, needs `TIDB_URL` |
| `docker compose up -d` | mysql, mariadb, postgres, libsql for the local suites |

`bench:tidb` runs against a **free** TiDB Serverless cluster. Keep it sequential and in the
low hundreds of statements; do not raise `--iterations` into the thousands.

The global `pnpm` on this machine is v10 and cannot install the pinned
`packageManager` (pnpm 11.20.0). Prefix with `corepack` — `corepack pnpm test` — or
`npm i -g pnpm@11.20.0` once.

Local integration suites read `.env` (copy `.env.example`). Any suite whose credential
is unset registers a named `test.skip` placeholder rather than failing, so `pnpm test`
is green without the hosted tiers. CI asserts the hosted suites actually ran.

## Layout

- `src/adapters/*` — one per driver: `d1`, `libsql`, `mysql2`, `pg`, `tidb-http`.
- `src/core/` — `client.ts` (knex client + pool + streaming), `infer.ts` (URL → driver,
  and `redact()`), `errors.ts` (`CfKnexError` and its closed `code` union),
  `response.ts`, `types.ts`.
- `src/index.ts` — the barrel. `buildAdapter`'s switch references all five factories, so
  this entry is ~6.2 kB and cannot be tree-shaken below that.
- `src/entries/*` — the per-database subpath exports (`cf-knex/tidb`, `/d1`, `/mysql`,
  `/postgres`, `/turso`), ~3 kB each. They exist so a Worker bundles one adapter. When
  you add an adapter, add its entry, its `exports`/`typesVersions` block, and its
  `.size-limit.json` rows.

**Engine vs driver.** `Engine` is `'mysql' | 'postgres' | 'sqlite'` — there is no
`'tidb'` engine. TiDB over HTTP is `{ engine: 'mysql', driver: 'tidb-http' }`.

**Which vitest project a test belongs to is a runtime question, not a test-kind
question.** `test/unit/**` means "must run in workerd"; `test/integration/**` means
"needs real Node" (`mysql2` and `pg` cannot be imported inside the workers pool at all).
D1's conformance suite lives under `test/unit/` for that reason — it needs `env.DB`,
which only exists in workerd. Forwarding a host env var into a workerd test requires a
`miniflare: { bindings: … }` entry in `vitest.config.ts` plus a field on `Cloudflare.Env`
in `test/env.d.ts`; `process.env` is empty there.

## Hard rules

- **No credentials in any committed file, ever.** `.gitignore` covers `.env*` by prefix
  (not exact name — an ad-hoc `.env.bak-…` once sat untracked-but-unignored). gitleaks
  scans the full history on every PR and gates merge.
- **`redact()` before any URL reaches an error message or a log.** Every throw path in
  `infer.ts` goes through it. New code that embeds a connection string must too.
- **Internal working notes are git-ignored and stay that way** (`docs/superpowers/`,
  `.superpowers/`). Never commit them, never reference them from a commit message, and
  never write a source comment that delegates its explanation to one — a committed
  comment must be self-contained. `README.md`, `LICENSE`, `CHANGELOG.md` and
  consumer-facing docs are normal committed files.
- **`type`, not `interface`** — enforced by eslint. The single exemption is
  `test/env.d.ts`, which needs declaration merging.
- **Never assume library internals.** Read the installed `dist/`. This project has been
  wrong about `@tidbcloud/serverless`'s transaction model, knex's dialect hooks, and
  changesets' tag format — each time by reasoning instead of reading.
- **Divergences between backends get a test, not a README sentence alone.** TiDB returns
  `insertId` as a bigint and `COUNT` as a decimal string where mysql2 gives numbers; both
  are pinned by assertions in `test/integration/tidb.test.ts`.
- **In prose, the query builder is "Knex.js".** Lowercase `knex` in code font is the npm
  package or an identifier. This applies to README, examples and the package description.

## Facts worth not rediscovering

- **Hyperdrive cannot front TiDB Cloud Serverless.** Config creation fails with
  "Hyperdrive does not currently support MySQL AuthSwitchRequest messages" (observed
  2026-08-06). TiDB Dedicated and self-hosted TiDB are fine — they are ordinary MySQL
  origins.
- **Hyperdrive does not support MySQL `COM_STMT_PREPARE`.** The mysql2 adapter calls
  `conn.query()`, never `.execute()`, which is why it works. Do not "optimise" that into
  prepared statements.
- **Aggregate return types differ per backend** (`count` is a string on `tidb-http` and
  `pg`, a number on `mysql2` and `libsql`; `sum`/`avg` are strings everywhere except
  libsql; `max`/`min` are always numbers). The table in the README is measured output.

## Branches and PRs

Everything reaches `master` through a pull request. No direct pushes.

Branch prefixes follow the conventional-commit type of the work:

```
feature/<slug>    fix/<slug>       docs/<slug>
test/<slug>       ci/<slug>        chore/<slug>       refactor/<slug>
```

Nothing in CI keys off the prefix — it is a convention for scanning the PR list, and it
matches the vocabulary the commit subjects already use (`feat:`, `fix:`, `docs:`, …).
Use whichever prefix describes the *deliverable*: a branch that adds tests for existing
behaviour is `test/`, but a branch that adds a feature and its tests is `feature/`.
Docs-only work is `docs/`. Do not open a `develop`/`release` branch — releases are
trunk-based through changesets and a long-lived integration branch would buy nothing.

Commits are conventional-commit style, imperative mood, explaining *why*. Backticks in a
commit message must go through `git commit -F <file>`, not `-m "…"`.

## Releases

1. Any PR that changes published behaviour adds a changeset: `corepack pnpm changeset`,
   pick `patch`/`minor`/`major`, write it for the CHANGELOG reader. Docs-only,
   test-only and CI-only PRs need none.
2. Merge to `master`. The `release` job runs `changesets/action`, which opens (or
   updates) a **"chore: version packages"** PR applying every pending changeset.
3. Merge *that* PR. The same job then publishes to npm, pushes the `v<version>` tag, and
   creates the GitHub Release.

Publishing uses **npm trusted publishing** (OIDC, `id-token: write`, provenance on) —
there is no npm token in the repo and none should be added. The `release` job checks each
dependency's result explicitly, so a *skipped* job can never be mistaken for a passing
one: it publishes only if `static`, `gitleaks`, `test` and `live` all genuinely succeeded.

The `live` job needs repository secrets (`TIDB_URL`, `TURSO_URL`, `TURSO_AUTH_TOKEN`,
`NEON_URL`). Set them with `gh secret set`; never paste their values into a transcript.
It is skipped on forked PRs, which cannot see secrets.

## Before opening a PR

`corepack pnpm lint && corepack pnpm typecheck && corepack pnpm test && corepack pnpm build && corepack pnpm check:package`

Then confirm `git status` is clean of `.env*` and anything under the ignored notes paths.
