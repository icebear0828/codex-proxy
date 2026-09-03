/**
 * Runtime tracking of fallback usage.
 *
 * The dashboard wants to visually signal when requests are being served by a
 * fallback — a backup account from the pool, or the last-resort fallback
 * upstream apikey. This module keeps a lightweight in-memory "recently used"
 * window so the UI can flash the fallback indicator while it is active and go
 * back to its normal look once requests stop relying on fallbacks.
 */

let lastFallbackUseMs: number | null = null;

/** How long a fallback is considered "active" after its last use. */
const ACTIVE_WINDOW_MS = 60_000;

export function markFallbackUsed(nowMs: number = Date.now()): void {
  lastFallbackUseMs = nowMs;
}

export function isFallbackActive(nowMs: number = Date.now()): boolean {
  return lastFallbackUseMs !== null && nowMs - lastFallbackUseMs < ACTIVE_WINDOW_MS;
}

export function getFallbackActivity(): { active: boolean; lastUsedAt: string | null } {
  const active = isFallbackActive();
  return {
    active,
    lastUsedAt: lastFallbackUseMs !== null ? new Date(lastFallbackUseMs).toISOString() : null,
  };
}
