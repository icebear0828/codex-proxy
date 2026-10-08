#!/bin/sh
set -e

# Architecture: x64 or arm64
# Only set CODEX_ARCH if it's not already set or is empty
if [ -z "${CODEX_ARCH}" ]; then
  UNAME_ARCH=$(uname -m)
  if [ "$UNAME_ARCH" = "aarch64" ]; then
    CODEX_ARCH="arm64"
  elif [ "$UNAME_ARCH" = "x86_64" ]; then
    CODEX_ARCH="x64"
  else
    CODEX_ARCH="$UNAME_ARCH"
  fi
  export CODEX_ARCH
fi

# Seed config defaults from the image into the mounted config volume.
# Only files the volume is missing are copied, so user edits and previously
# seeded defaults are never overwritten, while a newer image still delivers
# the config files it added (e.g. model-pricing.yaml) to an existing volume —
# the previous "directory is empty" check skipped every volume that had
# already been seeded once. Implemented as an explicit walk because busybox
# `cp -rn` skips an existing destination directory whole, which would miss
# files added inside an existing subdirectory (e.g. prompts/). The path
# overrides exist so this block can be exercised outside a container.
# >>> config-seed
DEFAULTS_DIR="${CODEX_ENTRYPOINT_DEFAULTS_DIR:-/defaults}"
CONFIG_DIR="${CODEX_ENTRYPOINT_CONFIG_DIR:-/app/config}"

seed_config_defaults() {
  src_dir="$1"
  dst_dir="$2"
  for entry in "$src_dir"/*; do
    [ -e "$entry" ] || continue
    name=$(basename "$entry")
    if [ -d "$entry" ]; then
      if mkdir -p "$dst_dir/$name" 2>/dev/null; then
        # Run recursive calls in a subshell: POSIX sh has no portable `local`,
        # and the child must not overwrite this frame's loop variables.
        ( seed_config_defaults "$entry" "$dst_dir/$name" )
      else
        echo "[Init] WARNING: cannot create $dst_dir/$name — skipping that subtree" >&2
      fi
    elif [ ! -e "$dst_dir/$name" ]; then
      cp "$entry" "$dst_dir/$name" 2>/dev/null || echo "[Init] WARNING: cannot copy $entry to $dst_dir/$name" >&2
    fi
  done
}

if [ -d "$DEFAULTS_DIR" ]; then
  before=$(find "$CONFIG_DIR" -type f 2>/dev/null | wc -l | tr -d ' ')
  if mkdir -p "$CONFIG_DIR"; then
    seed_config_defaults "$DEFAULTS_DIR" "$CONFIG_DIR"
    after=$(find "$CONFIG_DIR" -type f 2>/dev/null | wc -l | tr -d ' ')
    seeded=$((after - before))
    # Stay quiet when there is nothing to do: tooling reads this container's
    # stdout (e.g. the image smoke test parsing a version), so a no-op start
    # must not add noise.
    if [ "$seeded" -gt 0 ]; then
      echo "[Init] Config defaults: $seeded missing file(s) seeded from the image (existing files preserved)"
    fi
  else
    echo "[Init] WARNING: could not create $CONFIG_DIR — continuing with the existing config volume" >&2
  fi
fi
# <<< config-seed

# Ensure mounted volumes are writable by the node user (UID 1000).
# When Docker auto-creates bind-mount directories on the host,
# they default to root:root — the node user can't write to them.
chown -R node:node /app/data /app/config 2>/dev/null || true

exec gosu node "$@"
