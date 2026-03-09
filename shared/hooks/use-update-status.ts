import { useState, useEffect, useCallback, useRef } from "preact/hooks";

export interface UpdateStatus {
  proxy: {
    version: string;
    commit: string | null;
    can_self_update: boolean;
    mode: "git" | "docker" | "electron";
    commits_behind: number | null;
    commits: { hash: string; message: string }[];
    release: { version: string; body: string; url: string } | null;
    update_available: boolean;
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
    commits: { hash: string; message: string }[];
    release: { version: string; body: string; url: string } | null;
    update_available: boolean;
    mode: "git" | "docker" | "electron";
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

const RESTART_POLL_INTERVAL = 2000;
const RESTART_TIMEOUT = 30000;

export function useUpdateStatus() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartFailed, setRestartFailed] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => clearPolling, [clearPolling]);

  const startRestartPolling = useCallback(() => {
    setRestarting(true);
    setRestartFailed(false);
    clearPolling();

    // Wait a bit before first poll (server needs time to shut down)
    const initialDelay = setTimeout(() => {
      pollTimerRef.current = setInterval(async () => {
        try {
          const resp = await fetch("/health", { signal: AbortSignal.timeout(3000) });
          if (resp.ok) {
            clearPolling();
            location.reload();
          }
        } catch {
          // Server still down, keep polling
        }
      }, RESTART_POLL_INTERVAL);

      // Timeout fallback
      timeoutRef.current = setTimeout(() => {
        clearPolling();
        setRestarting(false);
        setRestartFailed(true);
      }, RESTART_TIMEOUT);
    }, 2000);

    // Store the initial delay timer for cleanup
    timeoutRef.current = initialDelay;
  }, [clearPolling]);

  const load = useCallback(async () => {
    try {
      const resp = await fetch("/admin/update-status");
      if (resp.ok) {
        setStatus(await resp.json() as UpdateStatus);
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
      const data = await resp.json() as CheckResult;
      if (!resp.ok) {
        setError("Check failed");
      } else {
        setResult(data);
        await load();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setChecking(false);
    }
  }, [load]);

  const applyUpdate = useCallback(async () => {
    setApplying(true);
    setError(null);
    try {
      const resp = await fetch("/admin/apply-update", { method: "POST" });
      const data = await resp.json() as { started: boolean; restarting?: boolean; error?: string };
      if (!resp.ok || !data.started) {
        setError(data.error ?? "Apply failed");
        setApplying(false);
      } else if (data.restarting) {
        // Server will restart — start polling for it to come back
        setApplying(false);
        startRestartPolling();
      } else {
        // Update succeeded but no auto-restart
        setApplying(false);
        await load();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setApplying(false);
    }
  }, [load, startRestartPolling]);

  return { status, checking, result, error, checkForUpdate, applyUpdate, applying, restarting, restartFailed };
}
