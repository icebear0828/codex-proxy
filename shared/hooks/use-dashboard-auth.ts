import { useState, useEffect, useCallback } from "preact/hooks";

export type DashboardAuthStatus = "loading" | "login" | "authenticated";

export function useDashboardAuth() {
  const [status, setStatus] = useState<DashboardAuthStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [isRemoteSession, setIsRemoteSession] = useState(false);

  const checkStatus = useCallback(async () => {
    try {
      const res = await fetch("/auth/dashboard-status");
      const data: { required: boolean; authenticated: boolean } = await res.json();
      if (!data.required || data.authenticated) {
        setStatus("authenticated");
        setIsRemoteSession(data.required && data.authenticated);
      } else {
        setStatus("login");
      }
    } catch {
      // If status endpoint fails, assume no gate (backwards compat)
      setStatus("authenticated");
    }
  }, []);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  const login = useCallback(async (password: string) => {
    setError(null);
    try {
      const res = await fetch("/auth/dashboard-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        setStatus("authenticated");
        setIsRemoteSession(true);
      } else {
        const data = await res.json();
        setError(data.error || "Login failed");
      }
    } catch {
      setError("Network error");
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await fetch("/auth/dashboard-logout", { method: "POST" });
    } finally {
      setStatus("login");
      setIsRemoteSession(false);
    }
  }, []);

  return { status, error, login, logout, isRemoteSession };
}
