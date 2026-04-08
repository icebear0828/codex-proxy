#!/bin/sh
# Read server port dynamically (PORT env var -> local.yaml -> default.yaml -> 8080)
RESOLVED_PORT=${PORT}
if [ -z "$RESOLVED_PORT" ]; then
  RESOLVED_PORT=$(grep -A5 '^server:' /app/data/local.yaml 2>/dev/null | grep 'port:' | head -1 | awk '{print $2}')
fi
if [ -z "$RESOLVED_PORT" ]; then
  RESOLVED_PORT=$(grep -A5 '^server:' /app/config/default.yaml 2>/dev/null | grep 'port:' | head -1 | awk '{print $2}')
fi
RESOLVED_PORT=${RESOLVED_PORT:-8080}

curl -fs "http://localhost:${RESOLVED_PORT}/health" || exit 1
