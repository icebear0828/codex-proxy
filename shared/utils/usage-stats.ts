/**
 * Pure helpers for usage-stats display: number/hit-rate formatting and
 * window aggregation. Lives in shared so it can be unit-tested in the
 * node environment without pulling in jsdom for the React render layer.
 */

import type { UsageDataPoint } from "../hooks/use-usage-stats";

/** Compact number with K/M suffix (uppercase, distinct from shared/utils/format). */
export function formatUsageNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

/** Pretty-print a cached/input ratio as a hit-rate percentage. */
export function formatHitRate(cached: number, input: number): string {
  if (input <= 0) return "—";
  const pct = (cached / input) * 100;
  if (pct === 0) return "0%";
  if (pct < 0.01) return "<0.01%";
  if (pct < 1) return `${pct.toFixed(2)}%`;
  return `${pct.toFixed(1)}%`;
}

/** Sum cached_tokens + input_tokens across a window of data points. */
export function sumWindow(points: ReadonlyArray<UsageDataPoint>): { cached: number; input: number } {
  let cached = 0;
  let input = 0;
  for (const p of points) {
    cached += p.cached_tokens ?? 0;
    input += p.input_tokens;
  }
  return { cached, input };
}
