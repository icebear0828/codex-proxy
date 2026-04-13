#!/bin/sh

RESOLVED_PORT=""
if [ -n "$PORT" ]; then
  RESOLVED_PORT="$PORT"
fi

if [ -z "$RESOLVED_PORT" ] && [ -f /app/data/local.yaml ]; then
  RESOLVED_PORT=$(grep -A5 '^server:' /app/data/local.yaml 2>/dev/null | grep 'port:' | head -1 | awk '{print $2}')
fi

if [ -z "$RESOLVED_PORT" ] && [ -f /app/config/default.yaml ]; then
  RESOLVED_PORT=$(grep -A5 '^server:' /app/config/default.yaml 2>/dev/null | grep 'port:' | head -1 | awk '{print $2}')
fi

if [ -z "$RESOLVED_PORT" ]; then
  RESOLVED_PORT=8080
fi

curl -fs "http://localhost:${RESOLVED_PORT}/health" || exit 1