import { Hono } from "hono";
import type { AccountPool } from "../auth/account-pool.js";
import {
  isCodexCliAvailable,
  loginViaCli,
  validateManualToken,
} from "../auth/chatgpt-oauth.js";

export function createAuthRoutes(pool: AccountPool): Hono {
  const app = new Hono();

  // Pending OAuth session (one at a time)
  let pendingOAuth: {
    authUrl: string;
    waitForCompletion: () => Promise<{ success: boolean; token?: string; error?: string }>;
  } | null = null;

  // Auth status (JSON) — pool-level summary
  app.get("/auth/status", (c) => {
    const authenticated = pool.isAuthenticated();
    const userInfo = pool.getUserInfo();
    const proxyApiKey = pool.getProxyApiKey();
    const summary = pool.getPoolSummary();
    return c.json({
      authenticated,
      user: authenticated ? userInfo : null,
      proxy_api_key: authenticated ? proxyApiKey : null,
      pool: summary,
    });
  });

  // Start OAuth login — returns JSON with authUrl instead of redirecting
  app.get("/auth/login", async (c) => {
    if (pool.isAuthenticated()) {
      return c.json({ authenticated: true });
    }

    const cliAvailable = await isCodexCliAvailable();
    if (!cliAvailable) {
      return c.json(
        { error: "Codex CLI not available. Please use manual token entry." },
        503,
      );
    }

    try {
      const session = await loginViaCli();
      pendingOAuth = session;

      // Start background wait for completion
      session.waitForCompletion().then((result) => {
        if (result.success && result.token) {
          pool.addAccount(result.token);
          console.log("[Auth] OAuth login completed successfully");
        } else {
          console.error("[Auth] OAuth login failed:", result.error);
        }
        pendingOAuth = null;
      });

      return c.json({ authUrl: session.authUrl });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[Auth] CLI OAuth failed:", msg);
      return c.json({ error: msg }, 500);
    }
  });

  // Manual token submission — adds to pool
  app.post("/auth/token", async (c) => {
    const body = await c.req.json<{ token: string }>();
    const token = body.token?.trim();

    if (!token) {
      c.status(400);
      return c.json({ error: "Token is required" });
    }

    const validation = validateManualToken(token);
    if (!validation.valid) {
      c.status(400);
      return c.json({ error: validation.error });
    }

    pool.addAccount(token);
    return c.json({ success: true });
  });

  // Logout — clears all accounts
  app.post("/auth/logout", (c) => {
    pool.clearToken();
    return c.json({ success: true });
  });

  return app;
}
