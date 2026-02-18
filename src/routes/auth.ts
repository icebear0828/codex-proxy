import { Hono } from "hono";
import type { AccountPool } from "../auth/account-pool.js";
import type { RefreshScheduler } from "../auth/refresh-scheduler.js";
import { validateManualToken } from "../auth/chatgpt-oauth.js";
import { getConfig } from "../config.js";
import {
  createOAuthSession,
  consumeSession,
  exchangeCode,
  startCallbackServer,
  requestDeviceCode,
  pollDeviceToken,
  importCliAuth,
} from "../auth/oauth-pkce.js";

export function createAuthRoutes(
  pool: AccountPool,
  scheduler: RefreshScheduler,
): Hono {
  const app = new Hono();

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

  // Start OAuth login — 302 redirect to Auth0 (same-machine shortcut)
  app.get("/auth/login", (c) => {
    const config = getConfig();
    const originalHost = c.req.header("host") || `localhost:${config.server.port}`;

    const { authUrl, port } = createOAuthSession(originalHost, "login");

    // Start temporary callback server for same-machine callback
    startCallbackServer(port, (accessToken, refreshToken) => {
      const entryId = pool.addAccount(accessToken, refreshToken);
      scheduler.scheduleOne(entryId, accessToken);
      console.log(`[Auth] OAuth via callback server — account ${entryId} added`);
    });

    return c.redirect(authUrl);
  });

  // POST /auth/login-start — returns { authUrl, state } for popup flow
  app.post("/auth/login-start", (c) => {
    const config = getConfig();
    const originalHost = c.req.header("host") || `localhost:${config.server.port}`;

    const { authUrl, state, port } = createOAuthSession(originalHost, "login");

    // Start temporary callback server for same-machine callback
    startCallbackServer(port, (accessToken, refreshToken) => {
      const entryId = pool.addAccount(accessToken, refreshToken);
      scheduler.scheduleOne(entryId, accessToken);
      console.log(`[Auth] OAuth via callback server — account ${entryId} added`);
    });

    return c.json({ authUrl, state });
  });

  // POST /auth/code-relay — accepts { callbackUrl }, parses code+state, exchanges tokens
  app.post("/auth/code-relay", async (c) => {
    const body = await c.req.json<{ callbackUrl: string }>();
    const callbackUrl = body.callbackUrl?.trim();

    if (!callbackUrl) {
      return c.json({ error: "callbackUrl is required" }, 400);
    }

    let url: URL;
    try {
      url = new URL(callbackUrl);
    } catch {
      return c.json({ error: "Invalid URL" }, 400);
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    if (error) {
      const desc = url.searchParams.get("error_description") || error;
      return c.json({ error: `OAuth error: ${desc}` }, 400);
    }

    if (!code || !state) {
      return c.json({ error: "URL must contain code and state parameters" }, 400);
    }

    const session = consumeSession(state);
    if (!session) {
      return c.json({ error: "Invalid or expired session. Please try again." }, 400);
    }

    try {
      const tokens = await exchangeCode(code, session.codeVerifier, session.redirectUri);
      const entryId = pool.addAccount(tokens.access_token, tokens.refresh_token);
      scheduler.scheduleOne(entryId, tokens.access_token);

      console.log(`[Auth] OAuth via code-relay — account ${entryId} added`);
      return c.json({ success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[Auth] Code relay token exchange failed:", msg);
      return c.json({ error: `Token exchange failed: ${msg}` }, 500);
    }
  });

  // OAuth callback — Auth0 redirects here after user login (legacy/fallback)
  app.get("/auth/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const error = c.req.query("error");
    const errorDescription = c.req.query("error_description");

    if (error) {
      console.error(`[Auth] OAuth error: ${error} — ${errorDescription}`);
      return c.html(errorPage(`OAuth error: ${errorDescription || error}`));
    }

    if (!code || !state) {
      return c.html(errorPage("Missing code or state parameter"), 400);
    }

    const session = consumeSession(state);
    if (!session) {
      return c.html(errorPage("Invalid or expired OAuth session. Please try again."), 400);
    }

    try {
      const tokens = await exchangeCode(code, session.codeVerifier, session.redirectUri);
      const entryId = pool.addAccount(tokens.access_token, tokens.refresh_token);
      scheduler.scheduleOne(entryId, tokens.access_token);

      console.log(`[Auth] OAuth login completed — account ${entryId} added`);

      // Redirect back to the original host the user was browsing from
      const returnUrl = `http://${session.returnHost}/`;
      return c.redirect(returnUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[Auth] Token exchange failed:", msg);
      return c.html(errorPage(`Token exchange failed: ${msg}`), 500);
    }
  });

  // ── Device Code Flow ────────────────────────────────────────────

  // POST /auth/device-login — start device code flow
  app.post("/auth/device-login", async (c) => {
    try {
      const deviceResp = await requestDeviceCode();
      console.log(`[Auth] Device code flow started — user_code: ${deviceResp.user_code}`);
      return c.json({
        userCode: deviceResp.user_code,
        verificationUri: deviceResp.verification_uri,
        verificationUriComplete: deviceResp.verification_uri_complete,
        deviceCode: deviceResp.device_code,
        expiresIn: deviceResp.expires_in,
        interval: deviceResp.interval,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[Auth] Device code request failed:", msg);
      return c.json({ error: msg }, 500);
    }
  });

  // GET /auth/device-poll/:deviceCode — poll for device code authorization
  app.get("/auth/device-poll/:deviceCode", async (c) => {
    const deviceCode = c.req.param("deviceCode");

    try {
      const tokens = await pollDeviceToken(deviceCode);
      const entryId = pool.addAccount(tokens.access_token, tokens.refresh_token);
      scheduler.scheduleOne(entryId, tokens.access_token);

      console.log(`[Auth] Device code flow completed — account ${entryId} added`);
      return c.json({ success: true });
    } catch (err: any) {
      const code = err.code || "unknown";
      if (code === "authorization_pending" || code === "slow_down") {
        return c.json({ pending: true, code });
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[Auth] Device code poll failed:", msg);
      return c.json({ error: msg }, 400);
    }
  });

  // ── CLI Token Import ───────────────────────────────────────────

  // POST /auth/import-cli — import token from Codex CLI auth.json
  app.post("/auth/import-cli", async (c) => {
    try {
      const cliAuth = importCliAuth();
      const entryId = pool.addAccount(cliAuth.access_token!, cliAuth.refresh_token);
      scheduler.scheduleOne(entryId, cliAuth.access_token!);

      console.log(`[Auth] CLI token imported — account ${entryId} added`);
      return c.json({ success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[Auth] CLI import failed:", msg);
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

    const entryId = pool.addAccount(token);
    scheduler.scheduleOne(entryId, token);
    return c.json({ success: true });
  });

  // Logout — clears all accounts
  app.post("/auth/logout", (c) => {
    pool.clearToken();
    return c.json({ success: true });
  });

  return app;
}

function errorPage(message: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Login Error</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #0d1117; color: #c9d1d9;
    display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px;
    padding: 2rem; max-width: 420px; text-align: center; }
  h2 { color: #f85149; margin-bottom: 1rem; }
  a { color: #58a6ff; }
</style></head>
<body><div class="card">
  <h2>Login Failed</h2>
  <p>${escapeHtml(message)}</p>
  <p style="margin-top:1rem"><a href="/">Back to Home</a></p>
</div></body></html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
