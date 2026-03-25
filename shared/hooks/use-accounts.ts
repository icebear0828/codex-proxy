import { useState, useEffect, useCallback } from "preact/hooks";
import type { Account } from "../types";

export function useAccounts() {
  const [list, setList] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [addVisible, setAddVisible] = useState(false);
  const [addInfo, setAddInfo] = useState("");
  const [addError, setAddError] = useState("");

  const loadAccounts = useCallback(async (fresh = false) => {
    setRefreshing(true);
    try {
      const url = fresh ? "/auth/accounts?quota=fresh" : "/auth/accounts?quota=true";
      const resp = await fetch(url);
      const data = await resp.json();
      setList(data.accounts || []);
      setLastUpdated(new Date());
    } catch {
      setList([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);

  // Auto-poll cached quota every 30s
  useEffect(() => {
    const timer = setInterval(() => loadAccounts(), 30_000);
    return () => clearInterval(timer);
  }, [loadAccounts]);

  // Listen for OAuth callback success
  useEffect(() => {
    const handler = async (event: MessageEvent) => {
      if (event.data?.type === "oauth-callback-success") {
        setAddVisible(false);
        setAddInfo("accountAdded");
        await loadAccounts();
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [loadAccounts]);

  const startAdd = useCallback(async () => {
    setAddInfo("");
    setAddError("");
    try {
      const resp = await fetch("/auth/login-start", { method: "POST" });
      const data = await resp.json();
      if (!resp.ok || !data.authUrl) {
        throw new Error(data.error || "failedStartLogin");
      }
      window.open(data.authUrl, "oauth_add", "width=600,height=700,scrollbars=yes");
      setAddVisible(true);

      // Poll for new account + focus/visibility detection
      const prevResp = await fetch("/auth/accounts");
      const prevData = await prevResp.json();
      const prevCount = prevData.accounts?.length || 0;

      let checking = false;
      const checkForNewAccount = async () => {
        if (checking) return;
        checking = true;
        try {
          const r = await fetch("/auth/accounts");
          const d = await r.json();
          if ((d.accounts?.length || 0) > prevCount) {
            cleanup();
            setAddVisible(false);
            setAddInfo("accountAdded");
            await loadAccounts();
          }
        } catch {} finally {
          checking = false;
        }
      };

      // Focus event — check immediately when window regains focus
      const onFocus = () => { checkForNewAccount(); };
      window.addEventListener("focus", onFocus);

      // Visibility change — check when tab becomes visible
      const onVisible = () => {
        if (document.visibilityState === "visible") checkForNewAccount();
      };
      document.addEventListener("visibilitychange", onVisible);

      // Interval polling as fallback
      const pollTimer = setInterval(checkForNewAccount, 2000);

      const cleanup = () => {
        clearInterval(pollTimer);
        window.removeEventListener("focus", onFocus);
        document.removeEventListener("visibilitychange", onVisible);
      };
      setTimeout(cleanup, 5 * 60 * 1000);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "failedStartLogin");
    }
  }, [loadAccounts]);

  const submitRelay = useCallback(
    async (callbackUrl: string) => {
      setAddInfo("");
      setAddError("");
      if (!callbackUrl.trim()) {
        setAddError("pleasePassCallback");
        return;
      }
      try {
        const resp = await fetch("/auth/code-relay", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ callbackUrl }),
        });
        const data = await resp.json();
        if (resp.ok && data.success) {
          setAddVisible(false);
          setAddInfo("accountAdded");
          await loadAccounts();
        } else {
          setAddError(data.error || "failedExchangeCode");
        }
      } catch (err) {
        setAddError(
          "networkError" + (err instanceof Error ? err.message : String(err))
        );
      }
    },
    [loadAccounts]
  );

  const deleteAccount = useCallback(
    async (id: string) => {
      try {
        const resp = await fetch("/auth/accounts/" + encodeURIComponent(id), {
          method: "DELETE",
        });
        if (!resp.ok) {
          const data = await resp.json();
          return data.error || "failedDeleteAccount";
        }
        await loadAccounts();
        return null;
      } catch (err) {
        return "networkError" + (err instanceof Error ? err.message : "");
      }
    },
    [loadAccounts]
  );

  const patchLocal = useCallback((accountId: string, patch: Partial<Account>) => {
    setList((prev) => prev.map((a) => a.id === accountId ? { ...a, ...patch } : a));
  }, []);

  const exportAccounts = useCallback(async (selectedIds?: string[], format?: "full" | "minimal") => {
    const params = new URLSearchParams();
    if (selectedIds && selectedIds.length > 0) params.set("ids", selectedIds.join(","));
    if (format === "minimal") params.set("format", "minimal");
    const qs = params.toString() ? `?${params.toString()}` : "";
    const resp = await fetch(`/auth/accounts/export${qs}`);
    const data = await resp.json() as { accounts: Array<{ id: string }> };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const date = new Date().toISOString().slice(0, 10);
    const suffix = format === "minimal" ? "-minimal" : "";
    a.download = `accounts-export${suffix}-${date}.json`;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, []);

  const importAccounts = useCallback(async (file: File): Promise<{
    success: boolean;
    added: number;
    updated: number;
    failed: number;
    errors: string[];
  }> => {
    const text = await file.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { success: false, added: 0, updated: 0, failed: 0, errors: ["Invalid JSON file"] };
    }
    // Support both { accounts: [...] } (export format) and raw array
    const accounts = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.accounts)
        ? parsed.accounts
        : null;
    if (!accounts) {
      return { success: false, added: 0, updated: 0, failed: 0, errors: ["Invalid format: expected { accounts: [...] }"] };
    }

    const resp = await fetch("/auth/accounts/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accounts }),
    });
    const result = await resp.json();
    if (resp.ok) {
      await loadAccounts();
    }
    return result;
  }, [loadAccounts]);

  const batchDelete = useCallback(async (ids: string[]): Promise<string | null> => {
    try {
      const resp = await fetch("/auth/accounts/batch-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (!resp.ok) {
        const data = await resp.json();
        return data.error || "Batch delete failed";
      }
      await loadAccounts();
      return null;
    } catch (err) {
      return "networkError" + (err instanceof Error ? err.message : "");
    }
  }, [loadAccounts]);

  const batchSetStatus = useCallback(async (ids: string[], status: "active" | "disabled"): Promise<string | null> => {
    try {
      const resp = await fetch("/auth/accounts/batch-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, status }),
      });
      if (!resp.ok) {
        const data = await resp.json();
        return data.error || "Batch status change failed";
      }
      await loadAccounts();
      return null;
    } catch (err) {
      return "networkError" + (err instanceof Error ? err.message : "");
    }
  }, [loadAccounts]);

  const toggleStatus = useCallback(async (id: string, currentStatus: string): Promise<string | null> => {
    const newStatus = currentStatus === "disabled" ? "active" : "disabled";
    return batchSetStatus([id], newStatus);
  }, [batchSetStatus]);

  const updateLabel = useCallback(async (id: string, label: string | null): Promise<string | null> => {
    try {
      const resp = await fetch(`/auth/accounts/${encodeURIComponent(id)}/label`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      });
      if (!resp.ok) {
        const data = await resp.json();
        return data.error || "Failed to update label";
      }
      patchLocal(id, { label: label ?? undefined });
      return null;
    } catch (err) {
      return "networkError" + (err instanceof Error ? err.message : "");
    }
  }, [patchLocal]);

  return {
    list,
    loading,
    refreshing,
    lastUpdated,
    addVisible,
    addInfo,
    addError,
    refresh: useCallback(() => loadAccounts(true), [loadAccounts]),
    patchLocal,
    startAdd,
    submitRelay,
    deleteAccount,
    exportAccounts,
    importAccounts,
    batchDelete,
    batchSetStatus,
    toggleStatus,
    updateLabel,
  };
}
