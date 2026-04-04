#!/bin/sh
# Try to get the port from the following sources in order:
# 1. Environment variable
# 2. Local config override (data/local.yaml)
# 3. Default config (config/default.yaml)
# 4. Fallback to 8080

PORT_LOCAL=$(grep -A5 '^server:' /app/data/local.yaml 2>/dev/null | grep 'port:' | head -1 | awk '{print $2}')
PORT_DEFAULT=$(grep -A5 '^server:' /app/config/default.yaml 2>/dev/null | grep 'port:' | head -1 | awk '{print $2}')

PORT=${PORT:-${PORT_LOCAL:-${PORT_DEFAULT:-8080}}}
curl -fs "http://localhost:${PORT:-8080}/health" || exit 1
