#!/usr/bin/env bash
set -euo pipefail

SHA="${1:?commit SHA is required}"
REPO="${2:?repository is required}"

# A commit can have many historical check-runs: release retries, beta builds,
# and scheduled jobs may all reuse the same SHA. Promotion must be gated by
# the current quality workflow only; an old release failure must not poison a
# commit after a later release retry succeeded.
if ! RUNS_JSON=$(gh api --paginate --slurp "repos/${REPO}/actions/runs?head_sha=${SHA}&per_page=100"); then
  printf '%s\n' "api-error"
  exit 0
fi

QUALITY_PATH=".github/workflows/ci-quality.yml"
LATEST_CONCLUSION=$(jq -r --arg path "$QUALITY_PATH" --arg sha "$SHA" '
  [ (if type == "array" then .[] else . end)
   | .workflow_runs[]?
   | select(.path == $path and .head_sha == $sha)
   | {conclusion, status, created_at}
  ]
  | sort_by(.created_at)
  | if length == 0 then "missing-checks" else .[-1] | if .status != "completed" then "not-green" else (.conclusion // "") end end
' <<< "$RUNS_JSON")

case "$LATEST_CONCLUSION" in
  success) printf '%s\n' "green" ;;
  missing-checks) printf '%s\n' "missing-checks" ;;
  *) printf '%s\n' "not-green" ;;
esac
