#!/bin/sh
set -e

# Ensure mounted volumes are writable by the node user (UID 1000).
# When Docker auto-creates bind-mount directories on the host,
# they default to root:root — the node user can't write to them.
chown -R node:node /app/data /app/config 2>/dev/null || true

exec gosu node "$@"
