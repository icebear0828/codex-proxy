#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd -P)
cd "$ROOT_DIR"

node_help() {
  echo "[Portable] $1" >&2
  echo "[Portable] This package does not include Node.js." >&2
  echo "[Portable] Install Node.js 20 or newer from https://nodejs.org/en/download/" >&2
  echo "[Portable] Or run with a specific executable:" >&2
  echo "  CODEX_PROXY_NODE=/opt/node/bin/node ./codex-proxy.sh -m browser" >&2
  echo "  ./codex-proxy.sh -p -m browser" >&2
  echo "[Portable] The command launched by this entry point is:" >&2
  echo "  node \"$ROOT_DIR/app/server.mjs\" --mode browser" >&2

  if [ ! -t 0 ] || [ ! -t 1 ] || [ ! -r /dev/tty ]; then
    echo "[Portable] No interactive terminal is available; exiting." >&2
    return
  fi

  printf "Open the official Node.js download page now? [y/N] (15 seconds): " >&2
  prompt_file=$(mktemp "${TMPDIR:-/tmp}/codex-proxy-node.XXXXXX") || return
  (
    IFS= read -r answer < /dev/tty || answer=
    printf '%s' "$answer" > "$prompt_file"
  ) &
  prompt_pid=$!
  elapsed=0
  while kill -0 "$prompt_pid" 2>/dev/null && [ "$elapsed" -lt 15 ]; do
    sleep 1
    elapsed=$((elapsed + 1))
  done
  if kill -0 "$prompt_pid" 2>/dev/null; then
    kill "$prompt_pid" 2>/dev/null || true
    wait "$prompt_pid" 2>/dev/null || true
    rm -f "$prompt_file"
    echo "" >&2
    echo "[Portable] No answer received; exiting." >&2
    return
  fi
  wait "$prompt_pid" 2>/dev/null || true
  answer=$(cat "$prompt_file")
  rm -f "$prompt_file"
  case "$answer" in
    y|Y|yes|YES|Yes)
      if command -v open >/dev/null 2>&1; then
        open "https://nodejs.org/en/download/" >/dev/null 2>&1 || true
      elif command -v xdg-open >/dev/null 2>&1; then
        xdg-open "https://nodejs.org/en/download/" >/dev/null 2>&1 || true
      else
        echo "[Portable] Open https://nodejs.org/en/download/ manually." >&2
      fi
      ;;
  esac
}

NODE_BIN=${CODEX_PROXY_NODE:-}
if [ "${1:-}" = "--node-path" ] || [ "${1:-}" = "-n" ]; then
  if [ "$#" -lt 2 ]; then
    echo "${1} requires a path" >&2
    exit 2
  fi
  NODE_BIN=$2
  shift 2
elif [ "${1:-}" != "" ] && [ "${1#--node-path=}" != "${1}" ]; then
  NODE_BIN=${1#--node-path=}
  shift
elif [ "${1:-}" != "" ] && [ "${1#-n=}" != "${1}" ]; then
  NODE_BIN=${1#-n=}
  shift
fi

if [ -z "$NODE_BIN" ]; then
  NODE_BIN=$(command -v node || true)
fi

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  node_help "Supported Node.js was not found."
  exit 127
fi

NODE_MAJOR=$($NODE_BIN -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)
case "$NODE_MAJOR" in
  ''|*[!0-9]*)
    node_help "Unable to determine Node.js version: $NODE_BIN"
    exit 2
    ;;
esac
if [ "$NODE_MAJOR" -lt 20 ]; then
  node_help "Node.js 20 or newer is required; found major version $NODE_MAJOR."
  exit 2
fi

mode_specified=false
for arg in "$@"; do
  case "$arg" in
    --mode|--mode=*|-m|-m=*) mode_specified=true ;;
  esac
done
if [ "$mode_specified" = false ]; then
  # A POSIX script launched from Git Bash still runs a Windows Node binary,
  # so process.platform may remain win32. Use browser explicitly here;
  # otherwise `--portable` without a mode could unexpectedly select WebView2.
  set -- --mode=browser "$@"
fi

exec "$NODE_BIN" "$ROOT_DIR/app/server.mjs" "$@"
