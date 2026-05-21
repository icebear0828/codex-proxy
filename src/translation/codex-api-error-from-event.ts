import { CodexApiError } from "../proxy/codex-types.js";

/**
 * Convert an upstream `error` / `response.failed` SSE event into a CodexApiError
 * with an HTTP-equivalent status. Used by the non-streaming collectors so the
 * proxy's catch path can run the same recovery logic (strip + retry) it would
 * have used for an HTTP-layer 4xx, instead of falling through as 502.
 */
export function codexApiErrorFromEvent(
  err: { code: string; message: string },
): CodexApiError {
  const status = statusForCode(err.code);
  const body = JSON.stringify({
    error: { type: err.code, code: err.code, message: err.message },
  });
  return new CodexApiError(status, body);
}

function statusForCode(code: string): number {
  const lower = code.toLowerCase();
  if (lower.includes("invalid_request") || lower.includes("not_found")) return 400;
  if (lower.includes("rate_limit") || lower.includes("usage_limit")) return 429;
  if (lower.includes("unauthorized") || lower.includes("invalid_api_key")) return 401;
  if (lower.includes("forbidden") || lower.includes("banned")) return 403;
  if (lower.includes("payment") || lower.includes("quota")) return 402;
  return 502;
}
