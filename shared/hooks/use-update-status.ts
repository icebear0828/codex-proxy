import { useState, useEffect, useCallback, useRef } from "preact/hooks";

export interface UpdateStatus {
  settings: {
    show_update_dialog: boolean;
  };
  proxy: {
    version: string;
    commit: string | null;
    can_self_update: boolean;
    mode: "git" | "docker" | "electron";
    commits_behind: number | null;
    commits: { hash: string; message: string }[];
    changelog: string | null;
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
    changelog: string | null;
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
const RESTART_TIMEOUT = 120000;

export interface UpdateStep {
  step: string;
  status: "running" | "done" | "error";
  detail?: string;
}

export function useUpdateStatus() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartFailed, setRestartFailed] = useState(false);
  const [updateSteps, setUpdateSteps] = useState<UpdateStep[]>([]);
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
    setUpdateSteps([]);
    try {
      const resp = await fetch("/admin/apply-update", { method: "POST" });
      if (!resp.ok) {
        const text = await resp.text();
        try {
          const data = JSON.parse(text) as { error?: string };
          setError(data.error ?? "Apply failed");
        } catch {
          setError(text || "Apply failed");
        }
        setApplying(false);
        return;
      }

      // Parse SSE stream
      const reader = resp.body?.getReader();
      if (!reader) {
        setError("No response body");
        setApplying(false);
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let shouldRestart = false;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Parse SSE lines
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const data = JSON.parse(line.slice(6)) as Record<string, unknown>;
            if (data.step && data.status) {
              setUpdateSteps((prev) => {
                const existing = prev.findIndex((s) => s.step === data.step);
                const entry: UpdateStep = {
                  step: data.step as string,
                  status: data.status as UpdateStep["status"],
                  detail: data.detail as string | undefined,
                };
                if (existing >= 0) {
                  const next = [...prev];
                  next[existing] = entry;
                  return next;
                }
                return [...prev, entry];
              });
            }
            if (data.done) {
              shouldRestart = !!(data.restarting);
              if (!data.started) {
                setError((data.error as string) ?? "Apply failed");
              }
            }
          } catch { /* skip malformed SSE */ }
        }
      }

      setApplying(false);
      if (shouldRestart) {
        startRestartPolling();
      } else if (!error) {
        await load();
      }
    } catch (err) {
      // Connection lost during update — server may be restarting
      setApplying(false);
      startRestartPolling();
    }
  }, [load, startRestartPolling, error]);

  return { status, checking, result, error, checkForUpdate, applyUpdate, applying, restarting, restartFailed, updateSteps };
}
