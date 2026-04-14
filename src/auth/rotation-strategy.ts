/**
 * Rotation strategy — stateless selection logic for AccountPool.
 * Strategies do not mutate input arrays or read config.
 */

import type { AccountEntry } from "./types.js";

export type RotationStrategyName = "least_used" | "round_robin" | "sticky";

export interface RotationState {
  roundRobinIndex: number;
}

export interface RotationStrategy {
  select(candidates: AccountEntry[], state: RotationState): AccountEntry;
}

const leastUsed: RotationStrategy = {
  select(candidates, state) {
    const cmp = (a: AccountEntry, b: AccountEntry): number => {
      // Primary: deprioritize quota-exhausted accounts
      const aExhausted = a.cachedQuota?.rate_limit?.limit_reached ? 1 : 0;
      const bExhausted = b.cachedQuota?.rate_limit?.limit_reached ? 1 : 0;
      if (aExhausted !== bExhausted) return aExhausted - bExhausted;
      // Secondary: prefer account whose quota resets soonest (use it before it resets).
      // Only compare when both have a known window — an account without window_reset_at
      // (e.g. brand new, never received rate-limit headers) must not be permanently
      // deprioritized behind one that has.  Fall through to request_count instead.
      const aReset = a.usage.window_reset_at;
      const bReset = b.usage.window_reset_at;
      if (aReset != null && bReset != null && aReset !== bReset) return aReset - bReset;
      // Tertiary: fewer requests = more remaining quota
      const diff = a.usage.request_count - b.usage.request_count;
      if (diff !== 0) return diff;
      // Quaternary: LRU
      const aTime = a.usage.last_used ? new Date(a.usage.last_used).getTime() : 0;
      const bTime = b.usage.last_used ? new Date(b.usage.last_used).getTime() : 0;
      return aTime - bTime;
    };
    const sorted = [...candidates].sort(cmp);
    // Rotate among tied front-runners to avoid thundering herd on cold start
    let tiedCount = 1;
    while (tiedCount < sorted.length && cmp(sorted[0], sorted[tiedCount]) === 0) {
      tiedCount++;
    }
    const pick = state.roundRobinIndex % tiedCount;
    state.roundRobinIndex++;
    return sorted[pick];
  },
};

const roundRobin: RotationStrategy = {
  select(candidates, state) {
    state.roundRobinIndex = state.roundRobinIndex % candidates.length;
    const selected = candidates[state.roundRobinIndex];
    state.roundRobinIndex++;
    return selected;
  },
};

const sticky: RotationStrategy = {
  select(candidates) {
    const sorted = [...candidates].sort((a, b) => {
      const aTime = a.usage.last_used ? new Date(a.usage.last_used).getTime() : 0;
      const bTime = b.usage.last_used ? new Date(b.usage.last_used).getTime() : 0;
      return bTime - aTime;
    });
    return sorted[0];
  },
};

const strategies: Record<RotationStrategyName, RotationStrategy> = {
  least_used: leastUsed,
  round_robin: roundRobin,
  sticky,
};

export function getRotationStrategy(name: RotationStrategyName): RotationStrategy {
  return strategies[name] ?? strategies.least_used;
}

/** @deprecated Use getRotationStrategy instead */
export const createRotationStrategy = getRotationStrategy;
