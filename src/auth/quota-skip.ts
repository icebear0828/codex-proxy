import type { AccountEntry, CodexQuota } from "./types.js";

/** True when any of the 3 cachedQuota buckets reports limit_reached. */
export function isQuotaExhausted(quota: CodexQuota | null | undefined): boolean {
  if (!quota) return false;
  return quota.rate_limit.limit_reached === true ||
    quota.secondary_rate_limit?.limit_reached === true ||
    quota.code_review_rate_limit?.limit_reached === true;
}

export function hasReachedCachedQuota(entry: AccountEntry): boolean {
  return isQuotaExhausted(entry.cachedQuota);
}
