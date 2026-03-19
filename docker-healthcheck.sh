#!/bin/sh
# Read server port from config, fallback to 8080
PORT=$(grep -A5 '^server:' /app/config/default.yaml 2>/dev/null | grep 'port:' | head -1 | awk '{print $2}')
curl -fs "http://localhost:${PORT:-8080}/health" || exit 1
