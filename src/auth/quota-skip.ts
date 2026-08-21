import type { AccountEntry, CodexQuota } from "./types.js";
import { getRateLimitIdForModel } from "./quota-utils.js";

/** True when the primary, secondary, code_review or model-specific cachedQuota bucket reports limit_reached. */
export function isQuotaExhausted(quota: CodexQuota | null | undefined, model?: string | null): boolean {
  if (!quota) return false;
  if (
    quota.rate_limit.limit_reached === true ||
    quota.secondary_rate_limit?.limit_reached === true ||
    quota.code_review_rate_limit?.limit_reached === true
  ) {
    return true;
  }
  const limitId = getRateLimitIdForModel(model);
  if (limitId && quota.rate_limits_by_limit_id?.[limitId]?.limit_reached === true) {
    return true;
  }
  return false;
}

export function hasReachedCachedQuota(entry: AccountEntry, model?: string | null): boolean {
  return isQuotaExhausted(entry.cachedQuota, model);
}
