import { useState, useEffect, useCallback } from "preact/hooks";

export type LogDirection = "ingress" | "egress" | "all";

export interface LogRecord {
  id: string;
  requestId: string;
  direction: LogDirection;
  ts: string;
  method: string;
  path: string;
  model?: string | null;
  provider?: string | null;
  status?: number | null;
  latencyMs?: number | null;
  stream?: boolean | null;
  error?: string | null;
  request?: unknown;
  response?: unknown;
}

export interface LogState {
  enabled: boolean;
  paused: boolean;
  dropped: number;
  size: number;
  capacity: number;
}

export function useLogs(refreshIntervalMs = 1500) {
  const [direction, setDirection] = useState<LogDirection>("all");
  const [search, setSearch] = useState("");
  const [records, setRecords] = useState<LogRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [state, setState] = useState<LogState | null>(null);
  const [selected, setSelected] = useState<LogRecord | null>(null);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({
        direction,
        search: search.trim(),
        limit: "50",
        offset: "0",
      });
      const resp = await fetch(`/admin/logs?${params.toString()}`);
      if (resp.ok) {
        const body = await resp.json();
        setRecords(body.records);
        setTotal(body.total);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, [direction, search]);

  const loadState = useCallback(async () => {
    try {
      const resp = await fetch("/admin/logs/state");
      if (resp.ok) setState(await resp.json());
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    setLoading(true);
    load();
    loadState();
    const id = setInterval(() => {
      load();
      loadState();
    }, refreshIntervalMs);
    return () => clearInterval(id);
  }, [load, loadState, refreshIntervalMs]);

  const setLogState = useCallback(async (patch: Partial<Pick<LogState, "enabled" | "paused">>) => {
    const resp = await fetch("/admin/logs/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (resp.ok) setState(await resp.json());
  }, []);

  const selectLog = useCallback(async (id: string) => {
    try {
      const resp = await fetch(`/admin/logs/${id}`);
      if (resp.ok) setSelected(await resp.json());
    } catch { /* ignore */ }
  }, []);

  return {
    direction,
    setDirection,
    search,
    setSearch,
    records,
    total,
    loading,
    state,
    setLogState,
    selected,
    selectLog,
  };
}
