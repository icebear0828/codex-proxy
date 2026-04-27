#!/bin/sh
# Read server port from environment, local override, or config, fallback to 8080

if [ -z "$PORT" ]; then
  # Check data/local.yaml first
  PORT=$(grep -A5 '^server:' /app/data/local.yaml 2>/dev/null | grep 'port:' | head -1 | awk '{print $2}')
fi

if [ -z "$PORT" ]; then
  # Fallback to config/default.yaml
  PORT=$(grep -A5 '^server:' /app/config/default.yaml 2>/dev/null | grep 'port:' | head -1 | awk '{print $2}')
fi

curl -fs "http://localhost:${PORT:-8080}/health" || exit 1
