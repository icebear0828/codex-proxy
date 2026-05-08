import type { AccountEntry } from "./types.js";

export function hasReachedCachedQuota(entry: AccountEntry): boolean {
  return entry.cachedQuota?.rate_limit.limit_reached === true ||
    entry.cachedQuota?.secondary_rate_limit?.limit_reached === true ||
    entry.cachedQuota?.code_review_rate_limit?.limit_reached === true;
}
