/**
 * Pure helpers for usage-stats display: number/hit-rate formatting and
 * window aggregation. Lives in shared so it can be unit-tested in the
 * node environment without pulling in jsdom for the React render layer.
 */

import type { UsageDataPoint } from "../hooks/use-usage-stats";

export interface UsageWindowTotals {
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  image_input_tokens: number;
  image_output_tokens: number;
  image_request_count: number;
  image_request_failed_count: number;
  request_count: number;
}

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

/** Sum all visible usage metrics across the selected history window. */
export function sumUsageWindow(points: ReadonlyArray<UsageDataPoint>): UsageWindowTotals {
  const totals: UsageWindowTotals = {
    input_tokens: 0,
    output_tokens: 0,
    cached_tokens: 0,
    image_input_tokens: 0,
    image_output_tokens: 0,
    image_request_count: 0,
    image_request_failed_count: 0,
    request_count: 0,
  };

  for (const p of points) {
    totals.input_tokens += p.input_tokens;
    totals.output_tokens += p.output_tokens;
    totals.cached_tokens += p.cached_tokens ?? 0;
    totals.image_input_tokens += p.image_input_tokens;
    totals.image_output_tokens += p.image_output_tokens;
    totals.image_request_count += p.image_request_count;
    totals.image_request_failed_count += p.image_request_failed_count;
    totals.request_count += p.request_count;
  }

  return totals;
}
