/**
 * Quota warning state store.
 * Tracks accounts approaching or exceeding quota limits.
 */

export interface QuotaWarning {
  accountId: string;
  email: string | null;
  window: "primary" | "secondary";
  level: "warning" | "critical";
  usedPercent: number;
  resetAt: number | null;
}

const _warnings = new Map<string, QuotaWarning[]>();
let _lastUpdated: string | null = null;

/**
 * Evaluate quota thresholds and return warnings for a single account.
 * Thresholds are sorted ascending; highest matched threshold determines level.
 */
export function evaluateThresholds(
  accountId: string,
  email: string | null,
  usedPercent: number | null,
  resetAt: number | null,
  window: "primary" | "secondary",
  thresholds: number[],
): QuotaWarning | null {
  if (usedPercent == null) return null;
  // Sort ascending
  const sorted = [...thresholds].sort((a, b) => a - b);
  // Find highest matched threshold
  let matchedIdx = -1;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (usedPercent >= sorted[i]) {
      matchedIdx = i;
      break;
    }
  }
  if (matchedIdx < 0) return null;

  // Highest threshold = critical, others = warning
  const level: "warning" | "critical" =
    matchedIdx === sorted.length - 1 ? "critical" : "warning";

  return { accountId, email, window, level, usedPercent, resetAt };
}

export function updateWarnings(accountId: string, warnings: QuotaWarning[]): void {
  if (warnings.length === 0) {
    _warnings.delete(accountId);
  } else {
    _warnings.set(accountId, warnings);
  }
  _lastUpdated = new Date().toISOString();
}

export function clearWarnings(accountId: string): void {
  _warnings.delete(accountId);
}

export function getActiveWarnings(): QuotaWarning[] {
  const all: QuotaWarning[] = [];
  for (const list of _warnings.values()) {
    all.push(...list);
  }
  return all;
}

export function getWarningsLastUpdated(): string | null {
  return _lastUpdated;
}
