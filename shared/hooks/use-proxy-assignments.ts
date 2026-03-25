import { useState, useEffect, useCallback } from "preact/hooks";
import type { ProxyEntry } from "../types";

export interface AssignmentAccount {
  id: string;
  email: string;
  label?: string;
  status: string;
  proxyId: string;
  proxyName: string;
}

export interface ImportDiff {
  changes: Array<{ email: string; accountId: string; from: string; to: string }>;
  unchanged: number;
}

export interface ProxyAssignmentsState {
  accounts: AssignmentAccount[];
  proxies: ProxyEntry[];
  loading: boolean;
  refresh: () => Promise<void>;
  assignBulk: (assignments: Array<{ accountId: string; proxyId: string }>) => Promise<void>;
  assignRule: (accountIds: string[], rule: string, targetProxyIds: string[]) => Promise<void>;
  exportAssignments: () => Promise<Array<{ email: string; proxyId: string }>>;
  importPreview: (data: Array<{ email: string; proxyId: string }>) => Promise<ImportDiff | null>;
  applyImport: (assignments: Array<{ accountId: string; proxyId: string }>) => Promise<void>;
}

export function useProxyAssignments(): ProxyAssignmentsState {
  const [accounts, setAccounts] = useState<AssignmentAccount[]>([]);
  const [proxies, setProxies] = useState<ProxyEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const resp = await fetch("/api/proxies/assignments");
      const data = await resp.json();
      setAccounts(data.accounts || []);
      setProxies(data.proxies || []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const assignBulk = useCallback(
    async (assignments: Array<{ accountId: string; proxyId: string }>) => {
      const resp = await fetch("/api/proxies/assign-bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignments }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: "Request failed" }));
        throw new Error((err as { error?: string }).error ?? "Request failed");
      }
      await refresh();
    },
    [refresh],
  );

  const assignRule = useCallback(
    async (accountIds: string[], rule: string, targetProxyIds: string[]) => {
      const resp = await fetch("/api/proxies/assign-rule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountIds, rule, targetProxyIds }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: "Request failed" }));
        throw new Error((err as { error?: string }).error ?? "Request failed");
      }
      await refresh();
    },
    [refresh],
  );

  const exportAssignments = useCallback(async (): Promise<Array<{ email: string; proxyId: string }>> => {
    const resp = await fetch("/api/proxies/assignments/export");
    if (!resp.ok) return [];
    const data: { assignments?: Array<{ email: string; proxyId: string }> } = await resp.json();
    return data.assignments || [];
  }, []);

  const importPreview = useCallback(
    async (data: Array<{ email: string; proxyId: string }>): Promise<ImportDiff | null> => {
      const resp = await fetch("/api/proxies/assignments/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignments: data }),
      });
      if (!resp.ok) return null;
      const result: ImportDiff = await resp.json();
      return result;
    },
    [],
  );

  const applyImport = useCallback(
    async (assignments: Array<{ accountId: string; proxyId: string }>) => {
      const resp = await fetch("/api/proxies/assignments/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignments }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: "Request failed" }));
        throw new Error((err as { error?: string }).error ?? "Request failed");
      }
      await refresh();
    },
    [refresh],
  );

  return {
    accounts,
    proxies,
    loading,
    refresh,
    assignBulk,
    assignRule,
    exportAssignments,
    importPreview,
    applyImport,
  };
}
