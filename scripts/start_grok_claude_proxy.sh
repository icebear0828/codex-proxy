#!/usr/bin/env bash
# Start codex-proxy dedicated to Claude Code -> Grok LB :2477 (port 8088).
# Does not modify data/local.yaml or ~/.claude/settings.json.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${CODEX_PROXY_GROK_CLAUDE_DATA:-$ROOT/data-grok-claude}"
export PORT="${CODEX_PROXY_GROK_CLAUDE_PORT:-8088}"
export CODEX_PROXY_HOST="${CODEX_PROXY_GROK_CLAUDE_HOST:-127.0.0.1}"

fail() {
  printf 'start_grok_claude_proxy: %s\n' "$*" >&2
  exit 78
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

check_mode() {
  require_cmd curl
  if ! curl -fsS --max-time 3 "http://127.0.0.1:2477/health" | grep -q '"pool_kind":"grok"'; then
    fail "Grok LB on 2477 not healthy or pool_kind is not grok"
  fi
  if [[ ! -f "$DATA_DIR/local.yaml" ]]; then
    fail "missing $DATA_DIR/local.yaml"
  fi
  if [[ ! -f "$DATA_DIR/api-keys.json" ]]; then
    fail "missing $DATA_DIR/api-keys.json"
  fi
  if [[ ! -f "$ROOT/dist/index.js" ]]; then
    fail "missing $ROOT/dist/index.js — run: cd $ROOT && npm run build"
  fi
  printf 'check_ok data_dir=%s port=%s\n' "$DATA_DIR" "$PORT"
}

if [[ "${1:-}" == "--check" ]]; then
  check_mode
  exit 0
fi

check_mode

export CODEX_PROXY_GROK_CLAUDE_DATA="$DATA_DIR"
cd "$ROOT"
exec node "$ROOT/scripts/grok-claude-server.mjs"