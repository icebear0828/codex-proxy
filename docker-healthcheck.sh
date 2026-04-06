#!/bin/sh
# Resolve port dynamically: PORT env var -> data/local.yaml -> config/default.yaml -> 8080
if [ -n "$PORT" ]; then
    TARGET_PORT="$PORT"
else
    TARGET_PORT=$(grep -A5 '^server:' /app/data/local.yaml 2>/dev/null | grep 'port:' | head -1 | awk '{print $2}' | tr -d '\r')
    if [ -z "$TARGET_PORT" ]; then
        TARGET_PORT=$(grep -A5 '^server:' /app/config/default.yaml 2>/dev/null | grep 'port:' | head -1 | awk '{print $2}' | tr -d '\r')
    fi
fi
curl -fs "http://localhost:${TARGET_PORT:-8080}/health" || exit 1
