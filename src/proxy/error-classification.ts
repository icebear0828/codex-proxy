/**
 * Shared error classification utilities for CodexApiError responses.
 *
 * Used by proxy-handler (request path) and usage-refresher (background quota fetch).
 *
 * Uses duck-typing ({ status, body, message }) instead of instanceof to stay
 * compatible with vi.mock'd CodexApiError in integration tests.
 */

interface CodexLikeError {
  status: number;
  body: string;
  message: string;
}

function isCodexLike(err: unknown): err is CodexLikeError {
  if (!(err instanceof Error)) return false;
  const rec = err as unknown as Record<string, unknown>;
  return typeof rec.status === "number" && typeof rec.body === "string";
}

/** Extract the rate-limit reset duration from a 429 error body, if available. */
export function extractRetryAfterSec(body: string): number | undefined {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const error = parsed.error as Record<string, unknown> | undefined;
    if (!error) return undefined;
    if (typeof error.resets_in_seconds === "number" && error.resets_in_seconds > 0) {
      return error.resets_in_seconds;
    }
    if (typeof error.resets_at === "number" && error.resets_at > 0) {
      const diff = error.resets_at - Date.now() / 1000;
      return diff > 0 ? diff : undefined;
    }
  } catch { /* use default backoff */ }
  return undefined;
}

/** Check if an error indicates the account is banned/suspended (non-CF 403). */
export function isBanError(err: unknown): boolean {
  if (!isCodexLike(err)) return false;
  if (err.status !== 403) return false;
  const body = err.body.toLowerCase();
  if (body.includes("cf_chl") || body.includes("<!doctype") || body.includes("<html")) return false;
  return true;
}

/** Check if an error is a 401 token invalidation (revoked/expired upstream). */
export function isTokenInvalidError(err: unknown): boolean {
  if (!isCodexLike(err)) return false;
  return err.status === 401;
}

/** Check if a CodexApiError indicates the model is not supported on the account's plan. */
export function isModelNotSupportedError(err: CodexLikeError): boolean {
  if (err.status < 400 || err.status >= 500 || err.status === 429) return false;
  const lower = err.message.toLowerCase();
  if (!lower.includes("model")) return false;
  return lower.includes("not supported") || lower.includes("not_supported")
    || lower.includes("not available") || lower.includes("not_available");
}
