/**
 * Hooks for fetching usage stats data.
 */

import { useState, useEffect, useCallback } from "preact/hooks";
import type { AccountQuota } from "../types";

export interface UsageSummary {
  total_input_tokens: number;
  total_output_tokens: number;
  total_cached_tokens: number;
  /** image_generation tool tokens (gpt-image-2). Tracked separately from host-model tokens. */
  total_image_input_tokens: number;
  total_image_output_tokens: number;
  /** image_generation request counts. Success = upstream returned image bytes;
   *  failed = silent strip (Free plan), upstream error, or empty-response on
   *  a request that declared the tool. */
  total_image_request_count: number;
  total_image_request_failed_count: number;
  total_estimated_cost_usd: number;
  total_request_count: number;
  total_accounts: number;
  active_accounts: number;
}

export interface UsageDataPoint {
  timestamp: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  image_input_tokens: number;
  image_output_tokens: number;
  image_request_count: number;
  image_request_failed_count: number;
  /** Estimated API-equivalent cost for this history bucket, in USD. */
  estimated_cost_usd?: number;
  request_count: number;
}

export type Granularity = "raw" | "five_min" | "hourly" | "daily";
export type UsageHistoryRange = number | "all";

export interface OfficialQuotaAccount {
  id: string;
  email: string | null;
  label: string | null;
  plan_type: string | null;
}

export interface OfficialQuotaResult {
  account: OfficialQuotaAccount;
  quota: AccountQuota | null;
  error: string | null;
}

export interface OfficialQuotaResponse {
  accounts: OfficialQuotaResult[];
}

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

export function useUsageHistory(granularity: Granularity, hours: UsageHistoryRange, refreshIntervalMs = 60_000) {
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

export function useUsageQuota(refreshIntervalMs = 30_000) {
  const [data, setData] = useState<OfficialQuotaResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const resp = await fetch("/admin/usage-stats/quota", {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const body: unknown = await resp.json();
      if (!body || typeof body !== "object" || !Array.isArray((body as { accounts?: unknown }).accounts)) {
        throw new Error("Invalid quota response");
      }
      setData(body as OfficialQuotaResponse);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to fetch quota");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void refresh();
    const id = setInterval(() => void refresh(), refreshIntervalMs);
    return () => clearInterval(id);
  }, [refresh, refreshIntervalMs]);

  return { data, loading, error, refresh };
}
