#!/bin/sh
set -e

# Seed config defaults from the image into the mounted config volume.
# docker-compose.yml mounts ./config onto /app/config; on a fresh install that
# directory is empty and shadows the config files baked into the image —
# without seeding, the server exits on the missing default.yaml. -r recursive,
# -n no-clobber: only files missing from the volume are copied, so user edits
# and previously seeded defaults are never overwritten, while a newer image
# still delivers config files it added (e.g. model-pricing.yaml) to an
# existing volume — the previous "directory is empty" check skipped every
# volume that had already been seeded once. The path overrides exist so this
# block can be exercised outside a container.
# >>> config-seed
DEFAULTS_DIR="${CODEX_ENTRYPOINT_DEFAULTS_DIR:-/defaults}"
CONFIG_DIR="${CODEX_ENTRYPOINT_CONFIG_DIR:-/app/config}"
if [ -d "$DEFAULTS_DIR" ]; then
  before=$(find "$CONFIG_DIR" -type f 2>/dev/null | wc -l | tr -d ' ')
  if mkdir -p "$CONFIG_DIR" 2>/dev/null && cp -rn "$DEFAULTS_DIR/." "$CONFIG_DIR/" 2>/dev/null; then
    after=$(find "$CONFIG_DIR" -type f 2>/dev/null | wc -l | tr -d ' ')
    echo "[Init] Config defaults: $((after - before)) missing file(s) seeded from the image (existing files preserved)"
  else
    echo "[Init] WARNING: could not seed missing config defaults from $DEFAULTS_DIR — continuing with the existing config volume" >&2
  fi
fi
# <<< config-seed

exec "$@"
