#!/usr/bin/env bash
set -euo pipefail

SHA="${1:?commit SHA is required}"
REPO="${2:?repository is required}"

QUALITY_PATH=".github/workflows/ci-quality.yml"

# A commit can have many historical check-runs: release retries, beta builds,
# and scheduled jobs may all reuse the same SHA. Promotion must be gated by
# the current quality workflow only; an old release failure must not poison a
# commit after a later release retry succeeded.
quality_conclusion() {
  local target_sha="$1"
  local runs_json

  if ! runs_json=$(gh api --paginate --slurp "repos/${REPO}/actions/runs?head_sha=${target_sha}&per_page=100"); then
    printf '%s\n' "api-error"
    return 0
  fi

  jq -r --arg path "$QUALITY_PATH" --arg sha "$target_sha" '
    [ (if type == "array" then .[] else . end)
     | .workflow_runs[]?
     | select(.path == $path and .head_sha == $sha)
     | {conclusion, status, created_at, run_number, run_attempt, id}
    ]
    | sort_by([.created_at, (.run_number // 0), (.run_attempt // 0), (.id // 0)])
    | if length == 0 then "missing-checks" else .[-1] | if .status != "completed" then "not-green" else (.conclusion // "") end end
  ' <<< "$runs_json"
}

LATEST_CONCLUSION=$(quality_conclusion "$SHA")
if [ "$LATEST_CONCLUSION" = "success" ]; then
  printf '%s\n' "green"
  exit 0
fi

# The changelog sync workflow intentionally skips CI for its bot-authored
# docs-only commit. It is safe to promote that commit only when the subject is
# exact, CHANGELOG.md is its sole changed file, and its parent has green CI.
# This keeps code changes gated while allowing the synchronized release notes
# to travel with the promotion (and pass the stable release-series check).
if [ "$LATEST_CONCLUSION" = "missing-checks" ]; then
  COMMIT_SUBJECT=$(git show -s --format=%s "$SHA" 2>/dev/null || true)
  PARENT_SHA=$(git rev-parse --verify "${SHA}^" 2>/dev/null || true)
  CHANGED_FILES=$(git diff-tree --no-commit-id --name-only -r "$SHA" 2>/dev/null || true)

  if [ "$COMMIT_SUBJECT" = "docs: sync changelog release series [skip ci]" ] &&
    [ -n "$PARENT_SHA" ] &&
    [ "$CHANGED_FILES" = "CHANGELOG.md" ]; then
    PARENT_CONCLUSION=$(quality_conclusion "$PARENT_SHA")
    case "$PARENT_CONCLUSION" in
      success) printf '%s\n' "green"; exit 0 ;;
      api-error) printf '%s\n' "api-error"; exit 0 ;;
      missing-checks) printf '%s\n' "missing-checks"; exit 0 ;;
      *) printf '%s\n' "not-green"; exit 0 ;;
    esac
  fi
fi

if [ "$LATEST_CONCLUSION" = "missing-checks" ]; then
  printf '%s\n' "missing-checks"
else
  printf '%s\n' "not-green"
fi
