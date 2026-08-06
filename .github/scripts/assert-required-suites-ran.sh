#!/usr/bin/env bash
# Fails loudly when a database that is genuinely available in this job was
# never actually exercised.
#
# The integration test files gate each conformance suite on a connection URL
# being set: when the var is absent they register a named placeholder via
# `test.skip('<suite> (<VAR> not set)', ...)` instead of a real test, so a
# run with the var missing still reports the file as "passed" — vitest's
# process exit code alone cannot distinguish "the suite ran and passed" from
# "the suite was never run". A typo in a workflow `env:` block, a job
# restructuring that drops a variable, or a matrix leg that forgets to
# inherit one would all silently take the skip path and the job would still
# go green.
#
# This reads vitest's own JSON reporter output and asserts that none of the
# named placeholders for the URLs THIS job actually provides show up in the
# skipped list. A URL this job does not provide (e.g. a live-only credential
# in the standard matrix job) is not checked here — that is an expected
# skip, not a defect, as long as it is never named on the command line.
#
# That check alone has a blind spot: it only ever looks for a *skipped*
# placeholder matching the name given. A name that doesn't correspond to
# anything in this report at all — a typo in the var name passed below, a
# suite renamed so its placeholder text no longer matches, a gated test file
# that got deleted, or this script being pointed at a report from the wrong
# vitest project — is indistinguishable from a suite that ran and passed:
# neither produces a skip. That's the same silent-green failure this script
# exists to prevent, moved up one level, so before checking for a skip, each
# var must first clear a positive-evidence bar: its suite has to actually
# show up somewhere in this report, passed or skipped, or the check doesn't
# count as having asserted anything and must fail loudly instead.
set -euo pipefail

report="$1"
shift

if [ "$#" -eq 0 ]; then
  echo "::error::no required env vars named to check — call with at least one, e.g. MYSQL_URL"
  exit 1
fi

if [ ! -f "$report" ]; then
  echo "::error::vitest JSON report not found at $report"
  exit 1
fi

# Each value is a substring that appears verbatim in a vitest `fullName`
# both when that var's suite runs for real (the name given to
# runConformanceSuite, which becomes its describe block) and when it's
# skipped (the same name, reused verbatim in the `<name> (<VAR> not set)`
# placeholder) — the two branches share the exact string literal in the test
# files. This map is the guard's only source of truth for "does this report
# even have a concept of this var"; extending the guard to a new gated var
# means adding it here.
declare -A VAR_TO_SUITE=(
  [MYSQL_URL]="mysql2 (direct, MySQL 8)"
  [MARIADB_URL]="mysql2 (direct, MariaDB 11)"
  [POSTGRES_URL]="pg (direct)"
  [LIBSQL_URL]="libsql (Turso / libsql-server, HTTP)"
  [TIDB_URL]="tidb-http (TiDB Cloud Serverless)"
)

all_names="$(jq -r '.testResults[].assertionResults[].fullName' "$report")"
skipped="$(jq -r '.testResults[].assertionResults[] | select(.status=="skipped") | .fullName' "$report")"

missing=0
for var in "$@"; do
  suite="${VAR_TO_SUITE[$var]:-}"

  # Positive-evidence gate: a var this script doesn't know how to map to a
  # suite, or one whose suite name doesn't appear anywhere in this report
  # (running or skipped), is unproven — treat that as a hard failure rather
  # than let it fall through and read as "nothing to complain about".
  if [ -z "$suite" ] || ! echo "$all_names" | grep -qF "$suite"; then
    echo "::error::no suite in this report is gated on ${var} — check the name and that the guard is reading the right project's report"
    missing=1
    continue
  fi

  if echo "$skipped" | grep -qF "(${var} not set)"; then
    echo "::error::a suite gated on ${var} was skipped, but ${var} is expected to be available in this job"
    missing=1
  fi
done

if [ "$missing" -ne 0 ]; then
  echo "--- full skipped list ---"
  echo "$skipped"
  exit 1
fi

echo "confirmed: no suite gated on any of [$*] was skipped, and each was found in this report"
