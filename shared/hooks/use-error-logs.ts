/**
 * Polls /admin/error-logs (groups + count) and exposes a "mark seen"
 * mutator that advances the read cursor.
 *
 * Default poll interval: 30 s. Cheap reads — JSONL tail + cursor file.
 * Components can also call `refresh()` after they take an action that
 * may add entries (e.g. test error capture).
 */

import { useState, useEffect, useCallback, useRef } from "preact/hooks";

export type ErrorSource = "main" | "renderer" | "server" | "external";

export interface ErrorGroup {
  signature: string;
  name: string;
  message: string;
  count: number;
  first_seen: string;
  last_seen: string;
  source: ErrorSource;
  sample_stack?: string;
  sample_context?: Record<string, unknown>;
}

export interface ErrorLogCount {
  total: number;
  unread: number;
}

const POLL_MS = 30_000;

export function useErrorLogs() {
  const [groups, setGroups] = useState<ErrorGroup[]>([]);
  const [count, setCount] = useState<ErrorLogCount>({ total: 0, unread: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const [gRes, cRes] = await Promise.all([
        fetch("/admin/error-logs"),
        fetch("/admin/error-logs/count"),
      ]);
      if (!gRes.ok || !cRes.ok) {
        setError("Failed to load error logs");
        return;
      }
      const g = (await gRes.json()) as { groups: ErrorGroup[] };
      const c = (await cRes.json()) as ErrorLogCount;
      setGroups(g.groups);
      setCount(c);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load error logs");
    } finally {
      setLoading(false);
    }
  }, []);

  const markAllSeen = useCallback(async () => {
    try {
      await fetch("/admin/error-logs/seen", { method: "POST" });
      await load();
    } catch {
      /* swallow */
    }
  }, [load]);

  useEffect(() => {
    void load();
    timerRef.current = setInterval(() => void load(), POLL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [load]);

  return { groups, count, loading, error, refresh: load, markAllSeen };
}

/**
 * Lightweight unread-count-only hook for the Header badge.
 * Polls the same endpoint but doesn't pull the full group payload.
 */
export function useErrorLogsCount() {
  const [count, setCount] = useState<ErrorLogCount>({ total: 0, unread: 0 });
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/admin/error-logs/count");
      if (r.ok) setCount((await r.json()) as ErrorLogCount);
    } catch {
      /* swallow */
    }
  }, []);

  useEffect(() => {
    void load();
    timerRef.current = setInterval(() => void load(), POLL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [load]);

  return count;
}

// ── Pure helpers (testable) ─────────────────────────────────────────

/** Format an ISO timestamp as a human-readable relative time. */
export function formatRelativeTime(ts: string, now: number = Date.now()): string {
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return ts;
  const diffSec = Math.floor((now - t) / 1000);
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}
