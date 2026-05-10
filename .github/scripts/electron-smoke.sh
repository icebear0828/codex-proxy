#!/usr/bin/env bash
#
# Cross-platform smoke test for a freshly-packed Electron artifact.
#
# Assumes the working directory contains `packages/electron/release/`
# (electron-builder's output dir) with the just-built artifact for
# the current $RUNNER_OS. Launches the binary, waits up to 90 s for
# it to log "Server started on port N", then hits /health. Exit 0 =
# the artifact starts cleanly; non-zero = ship-blocking failure.
#
# Why this matters: catches packaging-level breakage (broken asar
# unpack, missing native module, ESM bundler regressions like the
# v2.0.71/72 events bug) that source-level tests can't see.
#
# Required env:
#   RUNNER_OS    — set by GitHub Actions ("Linux" / "macOS" / "Windows")
#   RELEASE_DIR  — path to packages/electron/release (absolute or relative)
#   MAC_ARCH     — optional; "arm64" (default) or "x64", only on macOS

set -uo pipefail

LOG="${SMOKE_LOG:-$(mktemp)}"
TIMEOUT_SECS="${SMOKE_TIMEOUT:-90}"

die() {
  echo "::error::$*"
  echo "─── smoke log ───"
  if [ -f "$LOG" ]; then
    cat "$LOG"
  else
    echo "(no log captured)"
  fi
  exit 1
}

if [ -z "${RUNNER_OS:-}" ]; then
  die "RUNNER_OS not set (script expects to run inside GitHub Actions)"
fi

if [ -z "${RELEASE_DIR:-}" ]; then
  die "RELEASE_DIR not set"
fi

if [ ! -d "$RELEASE_DIR" ]; then
  die "RELEASE_DIR=$RELEASE_DIR does not exist"
fi

# Resolve the binary to launch per platform. Fail loudly if not found
# so a packaging change that renames artifacts trips this immediately
# rather than silently falsely passing.
case "$RUNNER_OS" in
  Linux)
    BINARY="$(ls "$RELEASE_DIR"/Codex-Proxy-*-linux-x86_64.AppImage 2>/dev/null | head -1 || true)"
    [ -n "$BINARY" ] || die "AppImage not found under $RELEASE_DIR"
    chmod +x "$BINARY"
    LAUNCH_CMD=("$BINARY" --no-sandbox)
    ;;
  macOS)
    ARCH="${MAC_ARCH:-arm64}"
    # electron-builder's output directory depends on whether one or
    # multiple archs were built in the same invocation. Single-arch
    # builds (the build-mac-x64 job invokes `--mac --x64` alone) land
    # in `release/mac/`; multi-arch matrix builds produce
    # `release/mac-arm64/` and `release/mac-x64/`. Search both shapes
    # before giving up.
    CANDIDATES=(
      "$RELEASE_DIR/mac-${ARCH}"
      "$RELEASE_DIR/mac"
    )
    APP=""
    for dir in "${CANDIDATES[@]}"; do
      APP="$(ls -d "$dir"/*.app 2>/dev/null | head -1 || true)"
      [ -n "$APP" ] && break
    done
    if [ -z "$APP" ]; then
      echo "::warning::Looked for .app in: ${CANDIDATES[*]}"
      echo "::warning::Contents of $RELEASE_DIR:"
      ls -la "$RELEASE_DIR" 2>&1 || true
      die "macOS .app ($ARCH) not found under $RELEASE_DIR"
    fi
    APP_NAME="$(basename "$APP" .app)"
    BINARY="$APP/Contents/MacOS/$APP_NAME"
    [ -x "$BINARY" ] || die "Mac binary not executable: $BINARY"
    LAUNCH_CMD=("$BINARY")
    ;;
  Windows)
    # win-unpacked is electron-builder's pre-installer staging dir;
    # using it sidesteps the NSIS install dance in CI.
    BINARY="$(ls "$RELEASE_DIR"/win-unpacked/*.exe 2>/dev/null | head -1 || true)"
    [ -n "$BINARY" ] || die "Windows exe not found under $RELEASE_DIR/win-unpacked"
    LAUNCH_CMD=("$BINARY" --no-sandbox)
    ;;
  *)
    die "Unsupported RUNNER_OS: $RUNNER_OS"
    ;;
esac

echo "Launching: ${LAUNCH_CMD[*]}"
echo "Log: $LOG"
echo "Timeout: ${TIMEOUT_SECS}s"

# Linux GUI process needs a virtual display.
# xvfb-run wraps the entire command, including any child processes.
if [ "$RUNNER_OS" = "Linux" ]; then
  xvfb-run -a --server-args="-screen 0 1024x768x24" "${LAUNCH_CMD[@]}" >"$LOG" 2>&1 &
else
  "${LAUNCH_CMD[@]}" >"$LOG" 2>&1 &
fi
APP_PID=$!

cleanup() {
  if [ -n "${APP_PID:-}" ] && kill -0 "$APP_PID" 2>/dev/null; then
    echo "Stopping app (pid=$APP_PID)"
    kill "$APP_PID" 2>/dev/null || true
    sleep 2
    kill -9 "$APP_PID" 2>/dev/null || true
  fi
  # Best-effort kill of any orphan Electron helpers / xvfb children.
  if [ "$RUNNER_OS" = "Linux" ]; then
    pkill -9 -f "Codex-Proxy" 2>/dev/null || true
    pkill -9 -f "xvfb" 2>/dev/null || true
  elif [ "$RUNNER_OS" = "macOS" ]; then
    pkill -9 -f "Codex Proxy" 2>/dev/null || true
  elif [ "$RUNNER_OS" = "Windows" ]; then
    # Best-effort; tasks may already be gone.
    taskkill //F //IM "Codex Proxy.exe" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# Tail the log for the well-known startup line. The Electron main logs
# `[Electron] Server started on port <N>` once the embedded server is
# bound and ready, so this both confirms launch and tells us which
# port to hit (the app falls back to a random port if the configured
# default is taken).
PORT=""
DEADLINE=$(( $(date +%s) + TIMEOUT_SECS ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if [ -f "$LOG" ]; then
    PORT=$(grep -oE 'Server started on port [0-9]+' "$LOG" 2>/dev/null \
      | grep -oE '[0-9]+' \
      | tail -1 || true)
    [ -n "$PORT" ] && break
  fi
  # Bail early if the process already died.
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    die "App process exited before starting the server (pid=$APP_PID)"
  fi
  sleep 1
done

[ -n "$PORT" ] || die "App did not log 'Server started on port N' within ${TIMEOUT_SECS}s"

echo "App reports server on port $PORT"

# Health probe — retry briefly because Electron logs "Server started"
# the moment startServer() returns, but `serve()` from
# @hono/node-server doesn't await the underlying socket bind. On fast
# hosts (observed on macOS arm64 GHA runner) the smoke script can
# race the bind and hit "connection refused" if it tries only once.
# 30 attempts × 1s = ~30s of patience; that's still well below the
# 90s outer timeout and just absorbs millisecond-scale jitter.
HEALTH_OK=false
for i in $(seq 1 30); do
  if curl -fsS --max-time 5 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    HEALTH_OK=true
    [ "$i" -gt 1 ] && echo "Health probe succeeded after $i attempt(s)"
    break
  fi
  sleep 1
done
if [ "$HEALTH_OK" != "true" ]; then
  die "Health probe failed: GET http://127.0.0.1:$PORT/health (gave up after 30s)"
fi

echo "✓ Smoke OK on $RUNNER_OS"
