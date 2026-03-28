import { useState, useEffect, useCallback } from "preact/hooks";

export interface GeneralSettingsData {
  port: number;
  proxy_url: string | null;
  force_http11: boolean;
  inject_desktop_context: boolean;
  suppress_desktop_directives: boolean;
  default_model: string;
  default_reasoning_effort: string;
  refresh_enabled: boolean;
  refresh_margin_seconds: number;
  refresh_concurrency: number;
  auto_update: boolean;
  auto_download: boolean;
}

interface GeneralSettingsSaveResponse extends GeneralSettingsData {
  success: boolean;
  restart_required: boolean;
}

export function useGeneralSettings(apiKey: string | null) {
  const [data, setData] = useState<GeneralSettingsData | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);

  const load = useCallback(async () => {
    try {
      const resp = await fetch("/admin/general-settings");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const result: GeneralSettingsData = await resp.json();
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const save = useCallback(async (patch: Partial<GeneralSettingsData>) => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }
      const resp = await fetch("/admin/general-settings", {
        method: "POST",
        headers,
        body: JSON.stringify(patch),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
        throw new Error((body as { error?: string }).error ?? `HTTP ${resp.status}`);
      }
      const result = await resp.json() as GeneralSettingsSaveResponse;
      setData({
        port: result.port,
        proxy_url: result.proxy_url,
        force_http11: result.force_http11,
        inject_desktop_context: result.inject_desktop_context,
        suppress_desktop_directives: result.suppress_desktop_directives,
        default_model: result.default_model,
        default_reasoning_effort: result.default_reasoning_effort,
        refresh_enabled: result.refresh_enabled,
        refresh_margin_seconds: result.refresh_margin_seconds,
        refresh_concurrency: result.refresh_concurrency,
        auto_update: result.auto_update,
        auto_download: result.auto_download,
      });
      setRestartRequired(result.restart_required);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [apiKey]);

  useEffect(() => { load(); }, [load]);

  return { data, saving, saved, error, save, load, restartRequired };
}
