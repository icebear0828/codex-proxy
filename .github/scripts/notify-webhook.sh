#!/usr/bin/env bash
# Best-effort plain-text webhook notification (ntfy-compatible: the body is
# the message). Silently no-ops when NOTIFY_WEBHOOK_URL is unset, and never
# fails the calling workflow.
set -u

MESSAGE="${1:-}"
if [ -z "${NOTIFY_WEBHOOK_URL:-}" ] || [ -z "$MESSAGE" ]; then
  exit 0
fi

curl -fsS -m 10 -X POST \
  -H "Content-Type: text/plain; charset=utf-8" \
  --data-binary "$MESSAGE" \
  "$NOTIFY_WEBHOOK_URL" >/dev/null \
  || echo "::warning::webhook notification failed (non-blocking)"
exit 0
