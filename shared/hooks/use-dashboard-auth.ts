import { useState, useEffect, useCallback } from "preact/hooks";

export type DashboardAuthStatus = "loading" | "login" | "authenticated";

/** Custom event fired when any fetch receives a 401 from dashboard endpoints. */
const AUTH_EXPIRED_EVENT = "codex:auth-expired";

/**
 * Install a one-time global fetch wrapper that detects 401 responses
 * from dashboard-protected endpoints and dispatches an auth-expired event.
 */
let interceptorInstalled = false;
function installFetchInterceptor(): void {
  if (interceptorInstalled) return;
  interceptorInstalled = true;

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const resp = await originalFetch(input, init);
    if (resp.status === 401) {
      // Only fire for dashboard endpoints, not for proxy API routes
      const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : (input as Request).url;
      const isProxyApi = url.includes("/v1/") || url.includes("/v1beta/");
      if (!isProxyApi) {
        window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
      }
    }
    return resp;
  };
}

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

  // Listen for auth-expired events from the global fetch interceptor
  useEffect(() => {
    installFetchInterceptor();
    const handler = () => {
      setStatus("login");
      setIsRemoteSession(false);
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, handler);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, handler);
  }, []);

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
