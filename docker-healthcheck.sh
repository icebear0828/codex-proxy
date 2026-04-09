#!/bin/sh
# Resolve port: 1. PORT env var -> 2. local.yaml -> 3. default.yaml -> 4. fallback 8080
if [ -z "$PORT" ]; then
  PORT=$(grep -A5 '^server:' /app/data/local.yaml 2>/dev/null | grep 'port:' | head -1 | awk '{print $2}')
fi
if [ -z "$PORT" ]; then
  PORT=$(grep -A5 '^server:' /app/config/default.yaml 2>/dev/null | grep 'port:' | head -1 | awk '{print $2}')
fi
curl -fs "http://localhost:${PORT:-8080}/health" || exit 1
