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
  select(candidates) {
    const sorted = [...candidates].sort((a, b) => {
      const diff = a.usage.request_count - b.usage.request_count;
      if (diff !== 0) return diff;
      const aReset = a.usage.window_reset_at ?? Infinity;
      const bReset = b.usage.window_reset_at ?? Infinity;
      if (aReset !== bReset) return aReset - bReset;
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
