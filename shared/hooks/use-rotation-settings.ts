import { useState, useEffect, useCallback } from "preact/hooks";

export type RotationStrategy = "least_used" | "round_robin" | "sticky";

export interface RotationSettingsData {
  rotation_strategy: RotationStrategy;
}

export function useRotationSettings(apiKey: string | null) {
  const [data, setData] = useState<RotationSettingsData | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const resp = await fetch("/admin/rotation-settings");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const result: RotationSettingsData = await resp.json();
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const save = useCallback(async (patch: Partial<RotationSettingsData>) => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }
      const resp = await fetch("/admin/rotation-settings", {
        method: "POST",
        headers,
        body: JSON.stringify(patch),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
        throw new Error((body as { error?: string }).error ?? `HTTP ${resp.status}`);
      }
      const result = await resp.json() as { success: boolean } & RotationSettingsData;
      setData({ rotation_strategy: result.rotation_strategy });
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
