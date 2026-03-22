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

export function useUsageSummary(refreshIntervalMs = 30_000) {
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const resp = await fetch("/admin/usage-stats/summary");
      if (resp.ok) setSummary(await resp.json());
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, refreshIntervalMs);
    return () => clearInterval(id);
  }, [load, refreshIntervalMs]);

  return { summary, loading };
}

export function useUsageHistory(granularity: Granularity, hours: number) {
  const [dataPoints, setDataPoints] = useState<UsageDataPoint[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    (async () => {
      try {
        const resp = await fetch(
          `/admin/usage-stats/history?granularity=${granularity}&hours=${hours}`,
        );
        if (resp.ok && !cancelled) {
          const body = await resp.json();
          setDataPoints(body.data_points);
        }
      } catch { /* ignore */ }
      if (!cancelled) setLoading(false);
    })();

    return () => { cancelled = true; };
  }, [granularity, hours]);

  return { dataPoints, loading };
}
