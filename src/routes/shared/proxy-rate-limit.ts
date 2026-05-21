import type { CodexQuota } from "../../auth/types.js";
import {
  parseRateLimitHeaders,
  rateLimitToQuota,
  type ParsedRateLimit,
} from "../../proxy/rate-limit-headers.js";

export interface RateLimitAccountPool {
  getEntry(entryId: string): { planType?: string | null } | null | undefined;
  updateCachedQuota(entryId: string, quota: CodexQuota): void;
  syncRateLimitWindow(entryId: string, newResetAt: number | null, limitWindowSeconds: number | null): void;
  applyRateLimit429(entryId: string, options?: { retryAfterSec?: number; resetsAtSec?: number; countRequest?: boolean }): void;
}

export interface ApplyParsedRateLimitsOptions {
  accountPool: RateLimitAccountPool;
  entryId: string;
  rateLimits: ParsedRateLimit;
  nowSec?: number;
}

export interface ApplyRateLimitHeadersOptions {
  accountPool: RateLimitAccountPool;
  entryId: string;
  headers: Headers | Record<string, string>;
  nowSec?: number;
}

export function applyParsedRateLimits(options: ApplyParsedRateLimitsOptions): void {
  const { accountPool, entryId, rateLimits, nowSec = Math.floor(Date.now() / 1000) } = options;
  const entry = accountPool.getEntry(entryId);
  const quota = rateLimitToQuota(rateLimits, entry?.planType ?? null);
  accountPool.updateCachedQuota(entryId, quota);

  if (rateLimits.primary?.reset_at != null) {
    const windowSec = rateLimits.primary.window_minutes != null ? rateLimits.primary.window_minutes * 60 : null;
    accountPool.syncRateLimitWindow(entryId, rateLimits.primary.reset_at, windowSec);
  }

  // Proactively mark exhausted accounts so they do not get re-selected.
  // updateCachedQuota above already records the truth; this call exists for
  // side effects: lifecycle.clearLock + WS pool eviction.
  if (quota.rate_limit.limit_reached && rateLimits.primary?.reset_at != null) {
    const backoffSec = rateLimits.primary.reset_at - nowSec;
    if (backoffSec > 0) {
      accountPool.applyRateLimit429(entryId, { resetsAtSec: rateLimits.primary.reset_at });
    }
  }
}

export function applyRateLimitHeaders(options: ApplyRateLimitHeadersOptions): boolean {
  const rateLimits = parseRateLimitHeaders(options.headers);
  if (!rateLimits) return false;
  applyParsedRateLimits({
    accountPool: options.accountPool,
    entryId: options.entryId,
    rateLimits,
    nowSec: options.nowSec,
  });
  return true;
}
