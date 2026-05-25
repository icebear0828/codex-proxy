#!/bin/sh
set -e

# Architecture: x64 or arm64
# Only set CODEX_ARCH if it's not already set or is empty
if [ -z "${CODEX_ARCH}" ]; then
  UNAME_ARCH=$(uname -p)
  if [ "$UNAME_ARCH" = "aarch64" ]; then
    CODEX_ARCH="arm64"
  elif [ "$UNAME_ARCH" = "x86_64" ]; then
    CODEX_ARCH="x64"
  else
    CODEX_ARCH="$UNAME_ARCH"
  fi
  export CODEX_ARCH
fi

# Seed empty config bind mount with defaults from the image
if [ -d /defaults ] && [ -z "$(ls -A /app/config 2>/dev/null)" ]; then
  echo "[Init] Config directory is empty — seeding from image defaults"
  mkdir -p /app/config
  cp -r /defaults/* /app/config/
fi

# Ensure mounted volumes are writable by the node user (UID 1000).
# When Docker auto-creates bind-mount directories on the host,
# they default to root:root — the node user can't write to them.
chown -R node:node /app/data /app/config 2>/dev/null || true

exec gosu node "$@"
