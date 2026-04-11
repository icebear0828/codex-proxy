#!/bin/sh
# Read server port from PORT env var, fallback to local config, then default config, then 8080
if [ -z "$PORT" ]; then
  PORT=$(grep -A5 '^server:' /app/data/local.yaml 2>/dev/null | grep 'port:' | head -1 | awk '{print $2}')
  if [ -z "$PORT" ]; then
    PORT=$(grep -A5 '^server:' /app/config/default.yaml 2>/dev/null | grep 'port:' | head -1 | awk '{print $2}')
  fi
fi
curl -fs "http://localhost:${PORT:-8080}/health" || exit 1
