#!/bin/sh
set -e

# Seed config defaults from the image into the mounted config volume.
# docker-compose.yml mounts ./config onto /app/config; on a fresh install that
# directory is empty and shadows the config files baked into the image —
# without seeding, the server exits on the missing default.yaml. Only files
# the volume is missing are copied, so user edits and previously seeded
# defaults are never overwritten, while a newer image still delivers config
# files it added (e.g. model-pricing.yaml) to an existing volume — the
# previous "directory is empty" check skipped every volume that had already
# been seeded once. Implemented as an explicit walk because busybox `cp -rn`
# skips an existing destination directory whole, which would miss files added
# inside an existing subdirectory (e.g. prompts/). The path overrides exist so
# this block can be exercised outside a container.
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
        seed_config_defaults "$entry" "$dst_dir/$name"
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
    echo "[Init] Config defaults: $((after - before)) missing file(s) seeded from the image (existing files preserved)"
  else
    echo "[Init] WARNING: could not create $CONFIG_DIR — continuing with the existing config volume" >&2
  fi
fi
# <<< config-seed

exec "$@"
