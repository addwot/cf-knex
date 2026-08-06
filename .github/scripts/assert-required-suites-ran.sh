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
# skip, not a defect.
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

skipped="$(jq -r '.testResults[].assertionResults[] | select(.status=="skipped") | .fullName' "$report")"

missing=0
for var in "$@"; do
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

echo "confirmed: no suite gated on any of [$*] was skipped"
