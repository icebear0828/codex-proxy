#!/bin/sh
# Resolve server port from PORT env, local.yaml, default.yaml, fallback to 8080
if [ -n "$PORT" ]; then
  HEALTH_PORT="$PORT"
elif [ -f "/app/data/local.yaml" ] && grep -A5 '^server:' /app/data/local.yaml 2>/dev/null | grep -q 'port:'; then
  HEALTH_PORT=$(grep -A5 '^server:' /app/data/local.yaml 2>/dev/null | grep 'port:' | head -1 | awk '{print $2}')
else
  HEALTH_PORT=$(grep -A5 '^server:' /app/config/default.yaml 2>/dev/null | grep 'port:' | head -1 | awk '{print $2}')
fi

curl -fs "http://localhost:${HEALTH_PORT:-8080}/health" || exit 1
