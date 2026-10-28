import { useState, useEffect, useCallback } from "preact/hooks";
import { extractErrorMessage } from "../utils/extract-error";

export interface PolicyGuardSettingsData {
  enabled: boolean;
  error_codes: string[];
  message_patterns: string[];
  status_codes: number[];
  ttl_seconds: number;
}

export interface ConversationQuarantine {
  conversation_id: string;
  code: string;
  message: string;
  recorded_at: string;
  age_seconds: number;
}

function authHeaders(apiKey: string | null): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  return headers;
}

export function usePolicyGuardSettings(apiKey: string | null) {
  const [data, setData] = useState<PolicyGuardSettingsData | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const resp = await fetch("/admin/policy-guard-settings");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      setData(await resp.json() as PolicyGuardSettingsData);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const save = useCallback(async (patch: Partial<PolicyGuardSettingsData>) => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const resp = await fetch("/admin/policy-guard-settings", {
        method: "POST",
        headers: authHeaders(apiKey),
        body: JSON.stringify(patch),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => null);
        throw new Error(extractErrorMessage(body, `HTTP ${resp.status}`));
      }
      const result = await resp.json() as { success: boolean; config: PolicyGuardSettingsData };
      setData(result.config);
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

/**
 * Active quarantines, plus the manual release the settings page needs: a false
 * positive cannot be cleared by editing the conversation (nothing is wrong with
 * it), so without this the only ways out are the TTL or a process restart.
 */
export function usePolicyGuardQuarantines(apiKey: string | null) {
  const [quarantines, setQuarantines] = useState<ConversationQuarantine[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await fetch("/admin/policy-guard-quarantines");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const result = await resp.json() as { quarantines: ConversationQuarantine[] };
      setQuarantines(result.quarantines ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const reset = useCallback(async (target: { conversationId?: string; all?: boolean }) => {
    try {
      const resp = await fetch("/admin/policy-guard-quarantines/reset", {
        method: "POST",
        headers: authHeaders(apiKey),
        body: JSON.stringify(
          target.all ? { all: true } : { conversation_id: target.conversationId },
        ),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => null);
        throw new Error(extractErrorMessage(body, `HTTP ${resp.status}`));
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [apiKey, refresh]);

  useEffect(() => { refresh(); }, [refresh]);

  return { quarantines, loading, error, refresh, reset };
}
