import { useState, useEffect, useCallback } from "preact/hooks";

export type ApiKeyProvider = "anthropic" | "openai" | "gemini" | "openrouter" | "custom";

export interface ApiKeyEntry {
  id: string;
  provider: ApiKeyProvider;
  model: string;
  apiKey: string; // masked
  baseUrl: string;
  label: string | null;
  status: "active" | "disabled" | "error";
  addedAt: string;
  lastUsedAt: string | null;
}

export interface CatalogModel {
  id: string;
  displayName: string;
}

export interface ProviderMeta {
  displayName: string;
  defaultBaseUrl: string;
  models: CatalogModel[];
}

export type Catalog = Record<string, ProviderMeta>;

export function useApiKeys() {
  const [keys, setKeys] = useState<ApiKeyEntry[]>([]);
  const [catalog, setCatalog] = useState<Catalog>({});
  const [loading, setLoading] = useState(true);

  const loadKeys = useCallback(async () => {
    try {
      const resp = await fetch("/auth/api-keys");
      const data = await resp.json();
      setKeys(data.keys || []);
    } catch {
      setKeys([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadCatalog = useCallback(async () => {
    try {
      const resp = await fetch("/auth/api-keys/catalog");
      const data = await resp.json();
      setCatalog(data.catalog || {});
    } catch {
      setCatalog({});
    }
  }, []);

  useEffect(() => {
    loadKeys();
    loadCatalog();
  }, [loadKeys, loadCatalog]);

  const addKey = useCallback(async (input: {
    provider: ApiKeyProvider;
    model: string;
    apiKey: string;
    baseUrl?: string;
    label?: string | null;
  }): Promise<{ ok: boolean; error?: string }> => {
    try {
      const resp = await fetch("/auth/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const data = await resp.json();
      if (!resp.ok) return { ok: false, error: data.error || "Failed" };
      await loadKeys();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Network error" };
    }
  }, [loadKeys]);

  const deleteKey = useCallback(async (id: string) => {
    try {
      await fetch(`/auth/api-keys/${id}`, { method: "DELETE" });
      await loadKeys();
    } catch { /* ignore */ }
  }, [loadKeys]);

  const toggleStatus = useCallback(async (id: string, status: "active" | "disabled") => {
    try {
      await fetch(`/auth/api-keys/${id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      await loadKeys();
    } catch { /* ignore */ }
  }, [loadKeys]);

  const updateLabel = useCallback(async (id: string, label: string | null) => {
    try {
      await fetch(`/auth/api-keys/${id}/label`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      });
      await loadKeys();
    } catch { /* ignore */ }
  }, [loadKeys]);

  const importKeys = useCallback(async (file: File): Promise<{ added: number; failed: number; errors: string[] }> => {
    const text = await file.text();
    const body = JSON.parse(text);
    const resp = await fetch("/auth/api-keys/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    await loadKeys();
    return { added: data.added || 0, failed: data.failed || 0, errors: data.errors || [] };
  }, [loadKeys]);

  const exportKeys = useCallback(async () => {
    const resp = await fetch("/auth/api-keys/export");
    const data = await resp.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "api-keys-export.json";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, []);

  return {
    keys,
    catalog,
    loading,
    addKey,
    deleteKey,
    toggleStatus,
    updateLabel,
    importKeys,
    exportKeys,
    refresh: loadKeys,
  };
}
