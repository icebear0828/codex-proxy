import { useState, useEffect, useCallback } from "preact/hooks";

export interface UpdateStatus {
  proxy: {
    version: string;
    commit: string | null;
    can_self_update: boolean;
    commits_behind: number | null;
    update_in_progress: boolean;
  };
  codex: {
    current_version: string | null;
    current_build: string | null;
    latest_version: string | null;
    latest_build: string | null;
    update_available: boolean;
    update_in_progress: boolean;
    last_check: string | null;
  };
}

export interface CheckResult {
  proxy?: {
    commits_behind: number;
    current_commit: string | null;
    latest_commit: string | null;
    update_applied?: boolean;
    error?: string;
  };
  codex?: {
    update_available: boolean;
    current_version: string;
    latest_version: string | null;
    version_changed?: boolean;
    error?: string;
  };
  proxy_update_in_progress: boolean;
  codex_update_in_progress: boolean;
}

export function useUpdateStatus() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const resp = await fetch("/admin/update-status");
      if (resp.ok) {
        setStatus(await resp.json());
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { load(); }, [load]);

  const checkForUpdate = useCallback(async () => {
    setChecking(true);
    setError(null);
    setResult(null);
    try {
      const resp = await fetch("/admin/check-update", { method: "POST" });
      const data: CheckResult = await resp.json();
      if (!resp.ok) {
        setError("Check failed");
      } else {
        setResult(data);
        // Refresh status after check
        await load();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setChecking(false);
    }
  }, [load]);

  return { status, checking, result, error, checkForUpdate };
}
