/**
 * Rotation strategy — stateless selection logic for AccountPool.
 * Strategies do not mutate input arrays or read config.
 */

import type { AccountEntry } from "./types.js";
import { isAnyLimitReached } from "./quota-utils.js";

export type RotationStrategyName = "least_used" | "round_robin" | "sticky";

export interface RotationState {
  roundRobinIndex: number;
}

export interface RotationStrategy {
  select(candidates: AccountEntry[], state: RotationState): AccountEntry;
}

const leastUsed: RotationStrategy = {
  select(candidates) {
    const sorted = [...candidates].sort((a, b) => {
      // Primary: deprioritize quota-exhausted accounts (primary OR secondary)
      const aExhausted = isAnyLimitReached(a.cachedQuota) ? 1 : 0;
      const bExhausted = isAnyLimitReached(b.cachedQuota) ? 1 : 0;
      if (aExhausted !== bExhausted) return aExhausted - bExhausted;
      // Secondary: prefer account whose quota resets soonest (use it before it resets)
      const aReset = a.usage.window_reset_at ?? Infinity;
      const bReset = b.usage.window_reset_at ?? Infinity;
      if (aReset !== bReset) return aReset - bReset;
      // Tertiary: fewer requests = more remaining quota
      const diff = a.usage.request_count - b.usage.request_count;
      if (diff !== 0) return diff;
      // Quaternary: LRU
      const aTime = a.usage.last_used ? new Date(a.usage.last_used).getTime() : 0;
      const bTime = b.usage.last_used ? new Date(b.usage.last_used).getTime() : 0;
      return aTime - bTime;
    });
    return sorted[0];
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
