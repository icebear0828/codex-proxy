#!/usr/bin/env bash
# Pick promotion candidates from dev that satisfy the soak window.
#
# The old rule ("dev HEAD must be >= 24h old") starved master during active
# weeks: every new dev commit reset the clock for the whole batch. Instead we
# promote the NEWEST first-parent dev commit older than the soak window —
# fresh commits keep soaking on dev and ride the next day's promotion.
#
# Env:
#   MASTER_REF      base ref           (default refs/remotes/origin/master)
#   DEV_REF         candidate source   (default refs/remotes/origin/dev)
#   MIN_AGE_SECONDS soak window        (default 86400)
#   MAX_CANDIDATES  output cap         (default 10)
#   NOW_EPOCH       clock override for tests (default: now)
#   FORCE           "true" bypasses soak and emits dev tip (hotfix path)
#
# Output: up to MAX_CANDIDATES eligible SHAs, newest first, one per line.
# The caller walks the list looking for a CI-green commit. Empty output means
# nothing is eligible today.
set -euo pipefail

MASTER_REF="${MASTER_REF:-refs/remotes/origin/master}"
DEV_REF="${DEV_REF:-refs/remotes/origin/dev}"
MIN_AGE_SECONDS="${MIN_AGE_SECONDS:-86400}"
MAX_CANDIDATES="${MAX_CANDIDATES:-10}"
NOW_EPOCH="${NOW_EPOCH:-$(date +%s)}"

if [ "${FORCE:-false}" = "true" ]; then
  git rev-parse "$DEV_REF"
  exit 0
fi

CUTOFF=$(( NOW_EPOCH - MIN_AGE_SECONDS ))

# First-parent keeps us on dev's mainline so every candidate is a state dev
# actually passed through (and a fast-forward of master by construction).
git rev-list --first-parent --format="%H %ct" --no-commit-header \
  "${MASTER_REF}..${DEV_REF}" \
  | awk -v cutoff="$CUTOFF" -v max="$MAX_CANDIDATES" \
      '$2 <= cutoff && n < max { print $1; n++ }'
