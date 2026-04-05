#!/bin/sh
if [ -n "$PORT" ]; then
  TARGET_PORT="$PORT"
else
  LOCAL_PORT=$(grep -A5 '^server:' /app/data/local.yaml 2>/dev/null | grep 'port:' | head -1 | awk '{print $2}')
  if [ -n "$LOCAL_PORT" ]; then
    TARGET_PORT="$LOCAL_PORT"
  else
    DEFAULT_PORT=$(grep -A5 '^server:' /app/config/default.yaml 2>/dev/null | grep 'port:' | head -1 | awk '{print $2}')
    TARGET_PORT="${DEFAULT_PORT:-8080}"
  fi
fi

curl -fs "http://localhost:${TARGET_PORT}/health" || exit 1
