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

for VAR in MIN_AGE_SECONDS MAX_CANDIDATES NOW_EPOCH; do
  if ! [[ "${!VAR}" =~ ^[0-9]+$ ]]; then
    echo "error: $VAR must be a non-negative integer, got '${!VAR}'" >&2
    exit 2
  fi
done

if [ "${FORCE:-false}" = "true" ]; then
  git rev-parse "$DEV_REF"
  exit 0
fi

CUTOFF=$(( NOW_EPOCH - MIN_AGE_SECONDS ))

# First-parent keeps us on dev's mainline (states dev actually passed
# through). That alone does NOT guarantee a fast-forward: after a sync-back
# merge (master merged INTO dev as a second parent), first-parent commits
# below the merge are not descendants of master, and pushing one would be
# rejected as non-ff. Filter each candidate explicitly.
COUNT=0
while read -r SHA; do
  if [ -z "$SHA" ]; then continue; fi
  git merge-base --is-ancestor "$MASTER_REF" "$SHA" 2>/dev/null || continue
  echo "$SHA"
  COUNT=$(( COUNT + 1 ))
  if [ "$COUNT" -ge "$MAX_CANDIDATES" ]; then break; fi
done < <(
  git rev-list --first-parent --format="%H %ct" --no-commit-header \
    "${MASTER_REF}..${DEV_REF}" \
    | awk -v cutoff="$CUTOFF" '$2 <= cutoff { print $1 }'
)
exit 0
