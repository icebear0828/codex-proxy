#!/usr/bin/env bash
# Install and enable user systemd unit for codex-proxy :8088 (Claude -> Grok LB).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYSTEMD_USER_DIR="${CODEX_SYSTEMD_USER_DIR:-$HOME/.config/systemd/user}"
CONFIG_DIR="${CODEX_PROXY_CONFIG_DIR:-$HOME/.config/codex-proxy}"
ENV_FILE="${CODEX_PROXY_GROK_CLAUDE_ENV:-$CONFIG_DIR/grok-claude-8088.env}"
SERVICE_NAME="${CODEX_PROXY_GROK_CLAUDE_SERVICE:-codex-proxy-grok-claude-8088.service}"
UNIT_FILE="$SYSTEMD_USER_DIR/$SERVICE_NAME"
NODE_BIN="${CODEX_PROXY_NODE_BIN:-$(command -v node || true)}"

fail() {
  printf 'install_grok_claude_systemd: %s\n' "$*" >&2
  exit 78
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

write_env() {
  install -d -m 700 "$CONFIG_DIR"
  if [[ -f "$ENV_FILE" && "${CODEX_PROXY_GROK_CLAUDE_OVERWRITE_ENV:-0}" != "1" ]]; then
    return
  fi
  umask 077
  cat >"$ENV_FILE" <<EOF
CODEX_PROXY_GROK_CLAUDE_DATA=$ROOT/data-grok-claude
PORT=8088
CODEX_PROXY_GROK_CLAUDE_PORT=8088
CODEX_PROXY_HOST=127.0.0.1
CODEX_PROXY_GROK_CLAUDE_HOST=127.0.0.1
EOF
}

write_unit() {
  [[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || fail "node not found; set CODEX_PROXY_NODE_BIN"
  install -d -m 700 "$SYSTEMD_USER_DIR"
  umask 077
  cat >"$UNIT_FILE" <<EOF
[Unit]
Description=Codex-proxy Anthropic shim for Claude Code -> Grok LB :2477 (127.0.0.1:8088)
After=network-online.target codex-lb-go-grok-pool-2477.service
Wants=network-online.target
Requires=codex-lb-go-grok-pool-2477.service

[Service]
Type=simple
WorkingDirectory=$ROOT
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN $ROOT/scripts/grok-claude-server.mjs
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
EOF
}

check_prereqs() {
  "$ROOT/scripts/start_grok_claude_proxy.sh" --check
  [[ -f "$ROOT/native/codex-tls.linux-x64-gnu.node" ]] || fail "missing native TLS: cd $ROOT/native && npm run build"
}

if [[ "${1:-}" == "--check" ]]; then
  require_cmd systemctl
  check_prereqs
  [[ -f "$UNIT_FILE" ]] || fail "unit not installed: run without --check"
  systemctl --user is-enabled "$SERVICE_NAME" >/dev/null 2>&1 || fail "service not enabled"
  curl -fsS --max-time 3 "http://127.0.0.1:8088/health" | grep -q '"status":"ok"' || fail "8088 health failed"
  printf 'check_ok service=%s\n' "$SERVICE_NAME"
  exit 0
fi

require_cmd systemctl
check_prereqs
write_env
write_unit
systemctl --user daemon-reload
systemctl --user enable --now "$SERVICE_NAME"
sleep 2
systemctl --user status "$SERVICE_NAME" --no-pager -l | head -20
curl -fsS --max-time 5 "http://127.0.0.1:8088/health" || fail "health check after start failed"
printf 'installed_and_enabled %s\n' "$SERVICE_NAME"