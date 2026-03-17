import { useState, useEffect, useCallback } from "preact/hooks";

export interface QuotaSettingsData {
  refresh_interval_minutes: number;
  warning_thresholds: { primary: number[]; secondary: number[] };
  skip_exhausted: boolean;
}

export function useQuotaSettings(apiKey: string | null) {
  const [data, setData] = useState<QuotaSettingsData | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const resp = await fetch("/admin/quota-settings");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const result: QuotaSettingsData = await resp.json();
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const save = useCallback(async (patch: Partial<QuotaSettingsData>) => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }
      const resp = await fetch("/admin/quota-settings", {
        method: "POST",
        headers,
        body: JSON.stringify(patch),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
        throw new Error((body as { error?: string }).error ?? `HTTP ${resp.status}`);
      }
      const result = await resp.json() as { success: boolean } & QuotaSettingsData;
      setData({
        refresh_interval_minutes: result.refresh_interval_minutes,
        warning_thresholds: result.warning_thresholds,
        skip_exhausted: result.skip_exhausted,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [apiKey]);

  useEffect(() => { load(); }, [load]);

  return { data, saving, saved, error, save, load };
}
