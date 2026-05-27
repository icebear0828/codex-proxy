import { useState, useEffect, useCallback } from "preact/hooks";
import type { ProxyEntry, ProxyAssignment } from "../types";

export interface AddProxyFields {
  name: string;
  /** Raw URL — when provided, skips field composition */
  url?: string;
  protocol: string;
  host: string;
  port: string;
  username: string;
  password: string;
}

export interface ProxiesState {
  proxies: ProxyEntry[];
  assignments: ProxyAssignment[];
  healthCheckIntervalMinutes: number;
  loading: boolean;
  refresh: () => Promise<void>;
  addProxy: (fields: AddProxyFields) => Promise<string | null>;
  removeProxy: (id: string) => Promise<string | null>;
  checkProxy: (id: string) => Promise<void>;
  checkAll: () => Promise<void>;
  enableProxy: (id: string) => Promise<void>;
  disableProxy: (id: string) => Promise<void>;
  assignProxy: (accountId: string, proxyId: string) => Promise<void>;
  unassignProxy: (accountId: string) => Promise<void>;
  setInterval: (minutes: number) => Promise<void>;
}

export function useProxies(): ProxiesState {
  const [proxies, setProxies] = useState<ProxyEntry[]>([]);
  const [assignments, setAssignments] = useState<ProxyAssignment[]>([]);
  const [healthCheckIntervalMinutes, setHealthInterval] = useState(5);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const resp = await fetch("/api/proxies");
      const data = await resp.json();
      setProxies(data.proxies || []);
      setAssignments(data.assignments || []);
      setHealthInterval(data.healthCheckIntervalMinutes || 5);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const addProxy = useCallback(
    async (fields: AddProxyFields): Promise<string | null> => {
      try {
        const resp = await fetch("/api/proxies", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            fields.url
              ? { name: fields.name, url: fields.url }
              : {
                  name: fields.name,
                  protocol: fields.protocol,
                  host: fields.host,
                  port: fields.port,
                  username: fields.username,
                  password: fields.password,
                },
          ),
        });
        const data = await resp.json();
        if (!resp.ok) return data.error || "Failed to add proxy";
        await refresh();
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : "Network error";
      }
    },
    [refresh],
  );

  const removeProxy = useCallback(
    async (id: string): Promise<string | null> => {
      try {
        const resp = await fetch(`/api/proxies/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
        if (!resp.ok) {
          const data = await resp.json();
          return data.error || "Failed to remove proxy";
        }
        await refresh();
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : "Network error";
      }
    },
    [refresh],
  );

  const checkProxy = useCallback(
    async (id: string) => {
      try {
        await fetch(`/api/proxies/${encodeURIComponent(id)}/check`, {
          method: "POST",
        });
      } catch {
        // network error — refresh will show stale state
      }
      await refresh();
    },
    [refresh],
  );

  const checkAll = useCallback(async () => {
    try {
      await fetch("/api/proxies/check-all", { method: "POST" });
    } catch {
      // network error
    }
    await refresh();
  }, [refresh]);

  const enableProxy = useCallback(
    async (id: string) => {
      try {
        await fetch(`/api/proxies/${encodeURIComponent(id)}/enable`, {
          method: "POST",
        });
      } catch {
        // network error
      }
      await refresh();
    },
    [refresh],
  );

  const disableProxy = useCallback(
    async (id: string) => {
      try {
        await fetch(`/api/proxies/${encodeURIComponent(id)}/disable`, {
          method: "POST",
        });
      } catch {
        // network error
      }
      await refresh();
    },
    [refresh],
  );

  const assignProxy = useCallback(
    async (accountId: string, proxyId: string) => {
      try {
        await fetch("/api/proxies/assign", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accountId, proxyId }),
        });
      } catch {
        // network error
      }
      await refresh();
    },
    [refresh],
  );

  const unassignProxy = useCallback(
    async (accountId: string) => {
      try {
        await fetch(`/api/proxies/assign/${encodeURIComponent(accountId)}`, {
          method: "DELETE",
        });
      } catch {
        // network error
      }
      await refresh();
    },
    [refresh],
  );

  const setIntervalMinutes = useCallback(
    async (minutes: number) => {
      try {
        await fetch("/api/proxies/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ healthCheckIntervalMinutes: minutes }),
        });
      } catch {
        // network error
      }
      await refresh();
    },
    [refresh],
  );

  return {
    proxies,
    assignments,
    healthCheckIntervalMinutes,
    loading,
    refresh,
    addProxy,
    removeProxy,
    checkProxy,
    checkAll,
    enableProxy,
    disableProxy,
    assignProxy,
    unassignProxy,
    setInterval: setIntervalMinutes,
  };
}
