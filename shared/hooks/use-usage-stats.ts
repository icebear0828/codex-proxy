/**
 * Hooks for fetching usage stats data.
 */

import { useState, useEffect, useCallback } from "preact/hooks";

export interface UsageSummary {
  total_input_tokens: number;
  total_output_tokens: number;
  total_request_count: number;
  total_accounts: number;
  active_accounts: number;
}

export interface UsageDataPoint {
  timestamp: string;
  input_tokens: number;
  output_tokens: number;
  request_count: number;
}

export type Granularity = "raw" | "hourly" | "daily";

/** 15 s fetch hard timeout — stops the dashboard from showing "—" forever
 *  when an extension, service worker, or upstream stall blackholes the
 *  request and neither resolves nor rejects. */
const FETCH_TIMEOUT_MS = 15_000;

export function useUsageSummary(refreshIntervalMs = 30_000) {
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const resp = await fetch("/admin/usage-stats/summary", {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (resp.ok) setSummary(await resp.json());
    } catch { /* network error / timeout / abort — fall through */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, refreshIntervalMs);
    return () => clearInterval(id);
  }, [load, refreshIntervalMs]);

  return { summary, loading };
}

export function useUsageHistory(granularity: Granularity, hours: number, refreshIntervalMs = 60_000) {
  const [dataPoints, setDataPoints] = useState<UsageDataPoint[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const resp = await fetch(
        `/admin/usage-stats/history?granularity=${granularity}&hours=${hours}`,
        { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
      );
      if (resp.ok) {
        const body = await resp.json();
        setDataPoints(body.data_points);
      }
    } catch { /* network error / timeout / abort — fall through */ }
    finally { setLoading(false); }
  }, [granularity, hours]);

  useEffect(() => {
    setLoading(true);
    load();
    const id = setInterval(load, refreshIntervalMs);
    return () => clearInterval(id);
  }, [load, refreshIntervalMs]);

  return { dataPoints, loading };
}
