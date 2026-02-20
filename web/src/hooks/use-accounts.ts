import { useState, useEffect, useCallback } from "preact/hooks";

export interface AccountQuota {
  rate_limit?: {
    used_percent?: number | null;
    limit_reached?: boolean;
    reset_at?: number | null;
  };
}

export interface Account {
  id: string;
  email: string;
  status: string;
  planType?: string;
  usage?: {
    request_count?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
  quota?: AccountQuota;
}

export function useAccounts() {
  const [list, setList] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [addVisible, setAddVisible] = useState(false);
  const [addInfo, setAddInfo] = useState("");
  const [addError, setAddError] = useState("");

  const loadAccounts = useCallback(async () => {
    try {
      const resp = await fetch("/auth/accounts?quota=true");
      const data = await resp.json();
      setList(data.accounts || []);
    } catch (err) {
      setList([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAccounts();
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

      // Poll for new account
      const prevResp = await fetch("/auth/accounts");
      const prevData = await prevResp.json();
      const prevCount = prevData.accounts?.length || 0;

      const pollTimer = setInterval(async () => {
        try {
          const r = await fetch("/auth/accounts");
          const d = await r.json();
          if ((d.accounts?.length || 0) > prevCount) {
            clearInterval(pollTimer);
            setAddVisible(false);
            setAddInfo("accountAdded");
            await loadAccounts();
          }
        } catch {}
      }, 2000);

      setTimeout(() => clearInterval(pollTimer), 5 * 60 * 1000);
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

  return {
    list,
    loading,
    addVisible,
    addInfo,
    addError,
    startAdd,
    submitRelay,
    deleteAccount,
  };
}
