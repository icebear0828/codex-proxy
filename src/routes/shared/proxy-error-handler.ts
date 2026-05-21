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
  isCfPathBlockError,
  isQuotaExhaustedError,
  isTokenInvalidError,
  isModelNotSupportedError,
} from "../../proxy/error-classification.js";
import type { CodexApiError } from "../../proxy/codex-types.js";
import type { StatusCode } from "hono/utils/http-status";
import type { CookieJar } from "../../proxy/cookie-jar.js";
import { recordCfPathBlock } from "../../auth/cf-path-block-tracker.js";
import { appendErrorLog } from "../../logs/error-log.js";

/** Consecutive CF path-blocks before the account is auto-disabled. */
const CF_PATH_BLOCK_DISABLE_THRESHOLD = 3;

/** Clamp an HTTP status to a valid error StatusCode, defaulting to 502 for non-error codes. */
export function toErrorStatus(status: number): StatusCode {
  return (status >= 400 && status < 600 ? status : 502) as StatusCode;
}

export type ErrorAction =
  | { action: "respond"; status: number; message: string; errorBody?: string }
  | {
      action: "retry";
      releaseBeforeRetry?: boolean;
      markModelRetried?: boolean;
      /** Fallback status/message when no retry account is available. */
      status: number;
      message: string;
      /** Use format429 instead of formatError for the fallback response. */
      useFormat429?: boolean;
    };

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
  cookieJar?: CookieJar,
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

  // 2. Rate-limited — write into cachedQuota.rate_limit (single source of
  // truth). applyRateLimit429 internally never shrinks an existing reset_at,
  // so a fresh secondary-window lock survives a stale primary 429.
  if (err.status === 429) {
    const retryAfterSec = extractRetryAfterSec(err.body);
    pool.applyRateLimit429(entryId, { retryAfterSec, countRequest: true });
    const backoffDisplay = retryAfterSec != null ? Math.round(retryAfterSec) : null;
    console.warn(
      `[${tag}] Account ${entryId} (${email}) | 429 rate limited` +
        (backoffDisplay != null ? ` (resets in ${backoffDisplay}s)` : "") +
        `, trying different account...`,
    );
    return { action: "retry", status: 429, message: err.message, useFormat429: true };
  }

  // 3. Quota exhausted (402 Payment Required)
  if (isQuotaExhaustedError(err)) {
    pool.markStatus(entryId, "quota_exhausted");
    console.warn(
      `[${tag}] Account ${entryId} (${email}) | 402 quota exhausted, trying different account...`,
    );
    return { action: "retry", status: 402, message: err.message };
  }

  // 4. Ban (non-Cloudflare 403)
  if (isBanError(err)) {
    pool.markStatus(entryId, "banned");
    console.warn(
      `[${tag}] Account ${entryId} (${email}) | 403 banned, trying different account...`,
    );
    return { action: "retry", status: 403, message: err.message };
  }

  // 5. Token invalidated / account deactivated
  if (isTokenInvalidError(err)) {
    const isDeactivated = err.message.toLowerCase().includes("deactivated");
    const newStatus = isDeactivated ? "banned" : "expired";
    pool.markStatus(entryId, newStatus);
    console.warn(
      `[${tag}] Account ${entryId} (${email}) | 401 ${isDeactivated ? "deactivated (banned)" : "token invalidated"}, trying different account...`,
    );
    return { action: "retry", status: 401, message: err.message };
  }

  // 6. Cloudflare path block (empty-body 404). CF's Bot Management can
  //    "hide" the /codex/responses path by returning 404 with no body when
  //    the captured __cf_bm cookie no longer matches the request
  //    fingerprint. Clear the cookie jar (so the next attempt is a clean,
  //    fingerprint-only request) and retry on a different account. After
  //    the threshold is reached within the sliding window, disable the
  //    account so session affinity stops pinning a dying conversation to
  //    it.
  if (isCfPathBlockError(err)) {
    cookieJar?.clear(entryId);
    const blockCount = recordCfPathBlock(entryId);
    if (blockCount >= CF_PATH_BLOCK_DISABLE_THRESHOLD) {
      pool.markStatus(entryId, "disabled");
      console.warn(
        `[${tag}] Account ${entryId} (${email}) | Cloudflare path-block 404 ×${blockCount} — auto-disabling account`,
      );
      appendErrorLog({
        source: "server",
        error: {
          name: "CfPathBlockAutoDisable",
          message: `Account auto-disabled after ${blockCount} consecutive Cloudflare path-block 404s on /codex/responses`,
        },
        context: { entryId, email, model, tag, blockCount },
      });
    } else {
      console.warn(
        `[${tag}] Account ${entryId} (${email}) | Cloudflare path-block 404 ×${blockCount}, cleared cookies and retrying...`,
      );
    }
    return {
      action: "retry",
      releaseBeforeRetry: true,
      status: 502,
      message: "Upstream blocked the request (Cloudflare path-block)",
    };
  }

  // 7. Generic error — return to client (preserve original body for passthrough)
  const status = toErrorStatus(err.status);
  return { action: "respond", status, message: err.message, errorBody: err.body };
}
