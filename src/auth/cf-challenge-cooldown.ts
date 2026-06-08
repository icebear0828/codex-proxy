const BACKOFF_SECONDS = [10, 30, 90, 120] as const;
const STALE_MS = 60 * 60 * 1000;

export interface CfChallengeCooldown {
  challengeCount: number;
  delaySeconds: number;
  cooldownUntilMs: number;
  updatedAtMs: number;
}

const cooldowns = new Map<string, CfChallengeCooldown>();

function delayForChallenge(challengeCount: number): number {
  const index = Math.min(Math.max(challengeCount, 1), BACKOFF_SECONDS.length) - 1;
  return BACKOFF_SECONDS[index];
}

export function recordCfChallengeCooldown(
  entryId: string,
  nowMs: number = Date.now(),
): CfChallengeCooldown {
  const previous = cooldowns.get(entryId);
  const challengeCount =
    !previous || nowMs - previous.updatedAtMs > STALE_MS
      ? 1
      : previous.challengeCount + 1;
  const delaySeconds = delayForChallenge(challengeCount);
  const state: CfChallengeCooldown = {
    challengeCount,
    delaySeconds,
    cooldownUntilMs: nowMs + delaySeconds * 1000,
    updatedAtMs: nowMs,
  };
  cooldowns.set(entryId, state);
  return state;
}

export function getCfChallengeCooldown(entryId: string): CfChallengeCooldown | null {
  return cooldowns.get(entryId) ?? null;
}

export function isCfChallengeCooldownActive(
  entryId: string,
  nowMs: number = Date.now(),
): boolean {
  const state = cooldowns.get(entryId);
  return state != null && nowMs < state.cooldownUntilMs;
}

export function clearCfChallengeCooldown(entryId: string): void {
  cooldowns.delete(entryId);
}

/** Visible for tests. */
export function _resetAllCfChallengeCooldowns(): void {
  cooldowns.clear();
}
