#!/usr/bin/env bash
set -euo pipefail

TAG="${1:-}"
if [ -z "$TAG" ]; then
  echo "usage: $0 <tag>" >&2
  exit 2
fi

release_notes_filter='^(chore|docs|ci)(\(.*\))?:'
promotion_filter='^(fix: promote dev release fixes to master|chore: promote dev to master)'

find_previous_tag() {
  if [[ "$TAG" == *-* ]]; then
    git describe --tags --abbrev=0 --match "v[0-9]*.[0-9]*.[0-9]*-*" "${TAG}^" 2>/dev/null || true
  else
    git describe --tags --abbrev=0 --exclude "*-*" --match "v[0-9]*.[0-9]*.[0-9]*" "${TAG}^" 2>/dev/null || true
  fi
}

find_stable_fallback_tag() {
  git describe --tags --abbrev=0 --exclude "*-*" --match "v[0-9]*.[0-9]*.[0-9]*" "${TAG}^" 2>/dev/null || true
}

PREV_TAG="$(find_previous_tag)"
if [ -z "$PREV_TAG" ] && [[ "$TAG" == *-* ]]; then
  PREV_TAG="$(find_stable_fallback_tag)"
fi

if [ -z "$PREV_TAG" ]; then
  echo "Initial release"
  exit 0
fi

build_body() {
  local end_ref="$1"
  git log "${PREV_TAG}..${end_ref}" --no-merges --pretty=format:"%s" \
    | grep -vE "$release_notes_filter" \
    | grep -vE "$promotion_filter" \
    | sed 's/^/- /' \
    || true
}

dev_tree_matches_release_payload() {
  git show-ref --verify --quiet refs/remotes/origin/dev || return 1
  # Stable tags created after a manual squash promotion may add only release
  # metadata on master (README/package version files). If all runtime/source
  # files match dev, dev has the real PR history that the squash hid.
  git diff --quiet "$TAG" refs/remotes/origin/dev -- . \
    ':(exclude)README.md' \
    ':(exclude)package.json' \
    ':(exclude)package-lock.json' \
    ':(exclude)packages/electron/package.json'
}

BODY="$(build_body "$TAG")"

if [[ "$TAG" != *-* ]] && [ -z "$BODY" ] && dev_tree_matches_release_payload; then
  DEV_BODY="$(build_body refs/remotes/origin/dev)"
  if [ -n "$DEV_BODY" ]; then
    BODY="$DEV_BODY"
  fi
fi

if [ -z "$BODY" ]; then
  BODY="Bug fixes and improvements"
fi

printf '%s\n' "$BODY" | node "$(dirname "$0")/translate-notes.js"

