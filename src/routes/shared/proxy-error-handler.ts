/**
 * Structured error handler for CodexApiError responses in the proxy handler.
 *
 * Returns an ErrorAction telling the orchestrator whether to retry (acquire
 * a new account) or respond with an error to the client.
 */

import type { AccountPool } from "../../auth/account-pool.js";
import {
  extractRetryAfterSec,
  isBanError,
  isTokenInvalidError,
  isModelNotSupportedError,
} from "../../proxy/error-classification.js";
import type { CodexApiError } from "../../proxy/codex-types.js";

/** Clamp an HTTP status to a valid error StatusCode, defaulting to 502 for non-error codes. */
export function toErrorStatus(status: number): number {
  return status >= 400 && status < 600 ? status : 502;
}

export interface ErrorAction {
  /** 'retry' = acquire new account and re-enter loop. 'respond' = return error to client. */
  action: "retry" | "respond";

  /** For retry: should the orchestrator release the current account before retrying? */
  releaseBeforeRetry?: boolean;

  /** For retry: should the orchestrator set modelRetried = true? */
  markModelRetried?: boolean;

  /** For respond (or retry fallback when no account available): HTTP status code. */
  status?: number;

  /** For respond (or retry fallback): error message. */
  message?: string;

  /** For retry fallback: use format429 instead of formatError. */
  useFormat429?: boolean;
}

/**
 * Classify a CodexApiError and mutate pool state accordingly.
 *
 * Returns an ErrorAction instructing the proxy-handler orchestrator on
 * what to do next.
 *
 * @param err           The CodexApiError from upstream
 * @param pool          AccountPool for status mutations
 * @param entryId       Current account entry ID
 * @param model         Requested model name
 * @param tag           Route tag for logging
 * @param modelRetried  Whether model-not-supported retry has already been attempted
 */
export function handleCodexApiError(
  err: CodexApiError,
  pool: AccountPool,
  entryId: string,
  model: string,
  tag: string,
  modelRetried: boolean,
): ErrorAction {
  const email = pool.getEntry(entryId)?.email ?? "?";

  // 1. Model not supported on this account's plan
  if (isModelNotSupportedError(err)) {
    if (!modelRetried) {
      console.warn(
        `[${tag}] Account ${entryId} (${email}) | Model "${model}" not supported, trying different account...`,
      );
      const fallbackStatus = toErrorStatus(err.status);
      return {
        action: "retry", releaseBeforeRetry: true, markModelRetried: true,
        status: fallbackStatus, message: err.message,
      };
    }
    const status = toErrorStatus(err.status);
    return { action: "respond", status, message: err.message };
  }

  console.error(`[${tag}] Account ${entryId} | Codex API error:`, err.message);

  // 2. Rate-limited
  if (err.status === 429) {
    const retryAfterSec = extractRetryAfterSec(err.body);
    pool.markRateLimited(entryId, { retryAfterSec, countRequest: true });
    console.warn(
      `[${tag}] Account ${entryId} (${email}) | 429 rate limited` +
        (retryAfterSec != null ? ` (resets in ${Math.round(retryAfterSec)}s)` : "") +
        `, trying different account...`,
    );
    return { action: "retry", status: 429, message: err.message, useFormat429: true };
  }

  // 3. Ban (non-Cloudflare 403)
  if (isBanError(err)) {
    pool.markStatus(entryId, "banned");
    console.warn(
      `[${tag}] Account ${entryId} (${email}) | 403 banned, trying different account...`,
    );
    return { action: "retry", status: 403, message: err.message };
  }

  // 4. Token invalidated
  if (isTokenInvalidError(err)) {
    pool.markStatus(entryId, "expired");
    console.warn(
      `[${tag}] Account ${entryId} (${email}) | 401 token invalidated, trying different account...`,
    );
    return { action: "retry", status: 401, message: err.message };
  }

  // 5. Generic error — return to client
  const status = toErrorStatus(err.status);
  return { action: "respond", status, message: err.message };
}
