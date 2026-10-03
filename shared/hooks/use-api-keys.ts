import { useState, useEffect, useCallback } from "preact/hooks";

export type ApiKeyProvider = "anthropic" | "openai" | "gemini" | "openrouter" | "antigravity" | "custom";
export type ApiKeyMemoProvider = Exclude<ApiKeyProvider, "antigravity">;
export type ApiKeyCapability = "chat" | "embeddings";
/** Upstream wire protocol used by runtime API-key entries. */
export type ApiKeyWire = "chat" | "responses" | "codex-responses" | "anthropic" | "gemini";

export interface ApiKeyEntry {
  id: string;
  provider: ApiKeyProvider;
  model: string;
  apiKey: string; // masked
  baseUrl: string;
  projectId?: string;
  label: string | null;
  capabilities: ApiKeyCapability[];
  wire: ApiKeyWire;
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

export interface FetchProviderModelsInput {
  provider: ApiKeyProvider;
  apiKey: string;
  baseUrl?: string;
  wire?: ApiKeyWire;
}

export type Catalog = Record<string, ProviderMeta>;

/** Memo — a saved add-key template; entries copied from it are independent. */
export interface ApiKeyMemo {
  id: string;
  name: string;
  provider: ApiKeyMemoProvider;
  baseUrl: string;
  wire: ApiKeyWire;
  capabilities: ApiKeyCapability[];
  models: CatalogModel[];
  modelsFetchedAt: string | null;
  createdAt: string;
}

export type MemoCoverage = { uncovered: number; canGenerate: boolean };

export function useApiKeys() {
  const [keys, setKeys] = useState<ApiKeyEntry[]>([]);
  const [catalog, setCatalog] = useState<Catalog>({});
  const [memos, setMemos] = useState<ApiKeyMemo[]>([]);
  const [memoCoverage, setMemoCoverage] = useState<MemoCoverage | null>(null);
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

  const loadMemos = useCallback(async () => {
    try {
      const resp = await fetch("/auth/api-keys/memos");
      const data = await resp.json();
      setMemos(Array.isArray(data.memos) ? data.memos : []);
    } catch {
      setMemos([]);
    }
  }, []);

  const loadMemoCoverage = useCallback(async () => {
    try {
      const resp = await fetch("/auth/api-keys/memos/coverage");
      const data = await resp.json();
      setMemoCoverage({ uncovered: data.uncovered ?? 0, canGenerate: Boolean(data.canGenerate) });
    } catch {
      setMemoCoverage(null);
    }
  }, []);

  const addKey = useCallback(async (input: {
    provider: ApiKeyProvider;
    models: string[];
    apiKey: string;
    baseUrl?: string;
    projectId?: string;
    label?: string | null;
    capabilities?: ApiKeyCapability[];
    wire?: ApiKeyWire;
    memoId?: string;
  }): Promise<{ ok: boolean; error?: string }> => {
    try {
      const resp = await fetch("/auth/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...input,
          // Memo-sourced adds may omit the key; the server resolves it.
          apiKey: input.apiKey || undefined,
        }),
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

  const fetchProviderModels = useCallback(async (input: FetchProviderModelsInput & { force?: boolean }): Promise<
    { ok: true; models: CatalogModel[]; fetchedAt?: string; fromCache?: boolean; stale?: boolean }
    | { ok: false; error: string }
  > => {
    try {
      const resp = await fetch("/auth/api-keys/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: input.provider,
          apiKey: input.apiKey.trim(),
          baseUrl: input.baseUrl?.trim(),
          wire: input.wire,
          force: input.force ?? false,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) return { ok: false, error: data.error || "Failed to fetch models" };
      const models = Array.isArray(data.models) ? data.models : [];
      return {
        ok: true,
        models,
        fetchedAt: typeof data.fetchedAt === "string" ? data.fetchedAt : undefined,
        fromCache: Boolean(data.fromCache),
        stale: Boolean(data.stale),
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Network error" };
    }
  }, []);

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

  const createMemo = useCallback(async (input: {
    name?: string;
    provider: ApiKeyMemoProvider;
    apiKey: string;
    baseUrl?: string;
    wire?: ApiKeyWire;
    capabilities?: ApiKeyCapability[];
  }): Promise<{ ok: boolean; memo?: ApiKeyMemo; error?: string }> => {
    try {
      const resp = await fetch("/auth/api-keys/memos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const data = await resp.json();
      if (!resp.ok) return { ok: false, error: data.error || "Failed to save memo" };
      await Promise.all([loadMemos(), loadMemoCoverage()]);
      return { ok: true, memo: data.memo };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Network error" };
    }
  }, [loadMemos, loadMemoCoverage]);

  const deleteMemo = useCallback(async (id: string) => {
    try {
      await fetch(`/auth/api-keys/memos/${id}`, { method: "DELETE" });
      await Promise.all([loadMemos(), loadMemoCoverage()]);
    } catch { /* ignore */ }
  }, [loadMemos, loadMemoCoverage]);

  const fetchMemoModels = useCallback(async (id: string, force = false): Promise<
    { ok: true; models: CatalogModel[]; fetchedAt?: string; stale?: boolean; memo?: ApiKeyMemo } | { ok: false; error: string }
  > => {
    try {
      const resp = await fetch(`/auth/api-keys/memos/${id}/models${force ? "?force=1" : ""}`, { method: "POST" });
      const data = await resp.json();
      if (!resp.ok) return { ok: false, error: data.error || "Failed to fetch models" };
      if (data.memo) {
        const updated = data.memo as ApiKeyMemo;
        setMemos((prev) => prev.map((memo) => (memo.id === updated.id ? updated : memo)));
      }
      const models = Array.isArray(data.models) ? data.models : [];
      return { ok: true, models, fetchedAt: data.fetchedAt, stale: Boolean(data.stale), memo: data.memo };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Network error" };
    }
  }, []);

  const generateMemos = useCallback(async (): Promise<{ created: number; skipped: number }> => {
    try {
      const resp = await fetch("/auth/api-keys/memos/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await resp.json();
      await Promise.all([loadMemos(), loadMemoCoverage()]);
      return { created: data.created ?? 0, skipped: data.skipped ?? 0 };
    } catch {
      return { created: 0, skipped: 0 };
    }
  }, [loadMemos, loadMemoCoverage]);

  return {
    keys,
    catalog,
    memos,
    memoCoverage,
    loading,
    loadMemos,
    loadMemoCoverage,
    addKey,
    deleteKey,
    toggleStatus,
    updateLabel,
    importKeys,
    exportKeys,
    fetchProviderModels,
    createMemo,
    deleteMemo,
    fetchMemoModels,
    generateMemos,
    refresh: loadKeys,
  };
}
