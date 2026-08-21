import { useState, useCallback, useEffect } from "preact/hooks";
import type {
  ClientKeyPublicSummary,
  ClientKeyEntry,
  CreateClientKeyInput,
  UpdateClientKeyInput,
} from "../types.js";

interface ClientKeysListResponse {
  keys: ClientKeyPublicSummary[];
  total: number;
  active: number;
  total_cost_usd: number;
  total_requests: number;
}

export function useClientKeys(masterApiKey?: string) {
  const [keys, setKeys] = useState<ClientKeyPublicSummary[]>([]);
  const [totalCostUsd, setTotalCostUsd] = useState<number>(0);
  const [totalRequests, setTotalRequests] = useState<number>(0);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const getHeaders = useCallback(async () => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    let key = masterApiKey;
    if (!key) {
      try {
        const res = await fetch("/auth/status");
        if (res.ok) {
          const statusData = (await res.json()) as { apiKey?: string };
          if (statusData.apiKey) key = statusData.apiKey;
        }
      } catch {
        // ignore
      }
    }
    if (key) {
      headers["Authorization"] = `Bearer ${key}`;
    }
    return headers;
  }, [masterApiKey]);

  const fetchKeys = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const headers = await getHeaders();
      const res = await fetch("/admin/client-keys", {
        headers,
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as ClientKeysListResponse;
      setKeys(data.keys || []);
      setTotalCostUsd(data.total_cost_usd || 0);
      setTotalRequests(data.total_requests || 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, [getHeaders]);

  const createKey = useCallback(
    async (input: CreateClientKeyInput): Promise<ClientKeyEntry> => {
      const headers = await getHeaders();
      const res = await fetch("/admin/client-keys", {
        method: "POST",
        headers,
        body: JSON.stringify(input),
      });
      const data = (await res.json().catch(() => ({}))) as { success?: boolean; key?: ClientKeyEntry; error?: string };
      if (!res.ok || !data.success || !data.key) {
        throw new Error(data.error || `Failed to create client key`);
      }
      await fetchKeys();
      return data.key;
    },
    [getHeaders, fetchKeys],
  );

  const updateKey = useCallback(
    async (id: string, input: UpdateClientKeyInput): Promise<ClientKeyEntry> => {
      const headers = await getHeaders();
      const res = await fetch(`/admin/client-keys/${id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify(input),
      });
      const data = (await res.json().catch(() => ({}))) as { success?: boolean; key?: ClientKeyEntry; error?: string };
      if (!res.ok || !data.success || !data.key) {
        throw new Error(data.error || `Failed to update client key`);
      }
      await fetchKeys();
      return data.key;
    },
    [getHeaders, fetchKeys],
  );

  const toggleStatus = useCallback(
    async (id: string): Promise<void> => {
      const headers = await getHeaders();
      const res = await fetch(`/admin/client-keys/${id}/toggle`, {
        method: "POST",
        headers,
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `Failed to toggle client key`);
      }
      await fetchKeys();
    },
    [getHeaders, fetchKeys],
  );

  const resetUsage = useCallback(
    async (id: string): Promise<void> => {
      const headers = await getHeaders();
      const res = await fetch(`/admin/client-keys/${id}/reset-usage`, {
        method: "POST",
        headers,
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `Failed to reset usage`);
      }
      await fetchKeys();
    },
    [getHeaders, fetchKeys],
  );

  const deleteKey = useCallback(
    async (id: string): Promise<void> => {
      const headers = await getHeaders();
      const res = await fetch(`/admin/client-keys/${id}`, {
        method: "DELETE",
        headers,
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `Failed to delete client key`);
      }
      await fetchKeys();
    },
    [getHeaders, fetchKeys],
  );

  useEffect(() => {
    fetchKeys();
  }, [fetchKeys]);

  return {
    keys,
    totalCostUsd,
    totalRequests,
    isLoading,
    error,
    fetchKeys,
    createKey,
    updateKey,
    toggleStatus,
    resetUsage,
    deleteKey,
  };
}
