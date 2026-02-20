/**
 * Account management API routes.
 *
 * GET    /auth/accounts            — list all accounts + usage + status
 * GET    /auth/accounts?quota=true — list all accounts with official quota
 * POST   /auth/accounts            — add account (token paste)
 * DELETE /auth/accounts/:id        — remove account
 * POST   /auth/accounts/:id/reset-usage — reset usage stats
 * GET    /auth/accounts/:id/quota  — query single account's official quota
 * GET    /auth/accounts/:id/cookies — view stored cookies
 * POST   /auth/accounts/:id/cookies — set cookies (for Cloudflare bypass)
 * DELETE /auth/accounts/:id/cookies — clear cookies
 * GET    /auth/accounts/login      — start OAuth to add a new account
 */

import { Hono } from "hono";
import type { AccountPool } from "../auth/account-pool.js";
import type { RefreshScheduler } from "../auth/refresh-scheduler.js";
import { validateManualToken } from "../auth/chatgpt-oauth.js";
import { createOAuthSession, startCallbackServer } from "../auth/oauth-pkce.js";
import { getConfig } from "../config.js";
import { CodexApi } from "../proxy/codex-api.js";
import type { CodexUsageResponse } from "../proxy/codex-api.js";
import type { CodexQuota, AccountInfo } from "../auth/types.js";
import type { CookieJar } from "../proxy/cookie-jar.js";

function toQuota(usage: CodexUsageResponse): CodexQuota {
  return {
    plan_type: usage.plan_type,
    rate_limit: {
      allowed: usage.rate_limit.allowed,
      limit_reached: usage.rate_limit.limit_reached,
      used_percent: usage.rate_limit.primary_window?.used_percent ?? null,
      reset_at: usage.rate_limit.primary_window?.reset_at ?? null,
    },
    code_review_rate_limit: usage.code_review_rate_limit
      ? {
          allowed: usage.code_review_rate_limit.allowed,
          limit_reached: usage.code_review_rate_limit.limit_reached,
          used_percent:
            usage.code_review_rate_limit.primary_window?.used_percent ?? null,
          reset_at:
            usage.code_review_rate_limit.primary_window?.reset_at ?? null,
        }
      : null,
  };
}

export function createAccountRoutes(
  pool: AccountPool,
  scheduler: RefreshScheduler,
  cookieJar?: CookieJar,
): Hono {
  const app = new Hono();

  /** Helper: build a CodexApi with cookie support. */
  function makeApi(entryId: string, token: string, accountId: string | null): CodexApi {
    return new CodexApi(token, accountId, cookieJar, entryId);
  }

  // Start OAuth flow to add a new account — 302 redirect to Auth0
  app.get("/auth/accounts/login", (c) => {
    const config = getConfig();
    const originalHost = c.req.header("host") || `localhost:${config.server.port}`;

    const { authUrl, port } = createOAuthSession(originalHost, "dashboard");

    // Start temporary callback server for same-machine callback
    startCallbackServer(port, (accessToken, refreshToken) => {
      const entryId = pool.addAccount(accessToken, refreshToken);
      scheduler.scheduleOne(entryId, accessToken);
      console.log(`[Auth] OAuth via callback server — account ${entryId} added`);
    });

    return c.redirect(authUrl);
  });

  // List all accounts (with optional ?quota=true)
  app.get("/auth/accounts", async (c) => {
    const accounts = pool.getAccounts();
    const wantQuota = c.req.query("quota") === "true";

    if (!wantQuota) {
      return c.json({ accounts });
    }

    // Fetch quota for every active account in parallel
    const enriched: AccountInfo[] = await Promise.all(
      accounts.map(async (acct) => {
        if (acct.status !== "active") return acct;

        const entry = pool.getEntry(acct.id);
        if (!entry) return acct;

        try {
          const api = makeApi(acct.id, entry.token, entry.accountId);
          const usage = await api.getUsage();
          // Sync rate limit window — auto-reset local counters on window rollover
          const resetAt = usage.rate_limit.primary_window?.reset_at ?? null;
          pool.syncRateLimitWindow(acct.id, resetAt);
          // Re-read usage after potential reset
          const freshAcct = pool.getAccounts().find((a) => a.id === acct.id) ?? acct;
          return { ...freshAcct, quota: toQuota(usage) };
        } catch {
          return acct; // skip on error — no quota field
        }
      }),
    );

    return c.json({ accounts: enriched });
  });

  // Add account
  app.post("/auth/accounts", async (c) => {
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

    const accounts = pool.getAccounts();
    const added = accounts.find((a) => a.id === entryId);
    return c.json({ success: true, account: added });
  });

  // Remove account
  app.delete("/auth/accounts/:id", (c) => {
    const id = c.req.param("id");
    scheduler.clearOne(id);
    const removed = pool.removeAccount(id);
    if (!removed) {
      c.status(404);
      return c.json({ error: "Account not found" });
    }
    cookieJar?.clear(id);
    return c.json({ success: true });
  });

  // Reset usage
  app.post("/auth/accounts/:id/reset-usage", (c) => {
    const id = c.req.param("id");
    const reset = pool.resetUsage(id);
    if (!reset) {
      c.status(404);
      return c.json({ error: "Account not found" });
    }
    return c.json({ success: true });
  });

  // Query single account's official quota
  app.get("/auth/accounts/:id/quota", async (c) => {
    const id = c.req.param("id");
    const entry = pool.getEntry(id);

    if (!entry) {
      c.status(404);
      return c.json({ error: "Account not found" });
    }

    if (entry.status !== "active") {
      c.status(409);
      return c.json({ error: `Account is ${entry.status}, cannot query quota` });
    }

    const hasCookies = !!(cookieJar?.getCookieHeader(id));

    try {
      const api = makeApi(id, entry.token, entry.accountId);
      const usage = await api.getUsage();
      return c.json({ quota: toQuota(usage), raw: usage });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const isCf = detail.includes("403") || detail.includes("cf_chl");
      c.status(502);
      return c.json({
        error: "Failed to fetch quota from Codex API",
        detail,
        hint: isCf && !hasCookies
          ? "Cloudflare blocked this request. Set cookies via POST /auth/accounts/:id/cookies with your browser's cf_clearance cookie."
          : undefined,
      });
    }
  });

  // ── Cookie management ──────────────────────────────────────────

  // View cookies for an account
  app.get("/auth/accounts/:id/cookies", (c) => {
    const id = c.req.param("id");
    if (!pool.getEntry(id)) {
      c.status(404);
      return c.json({ error: "Account not found" });
    }

    const cookies = cookieJar?.get(id) ?? null;
    return c.json({
      cookies,
      hint: !cookies
        ? "No cookies set. POST cookies from your browser to bypass Cloudflare. Example: { \"cookies\": \"cf_clearance=VALUE; __cf_bm=VALUE\" }"
        : undefined,
    });
  });

  // Set cookies for an account
  app.post("/auth/accounts/:id/cookies", async (c) => {
    const id = c.req.param("id");
    if (!pool.getEntry(id)) {
      c.status(404);
      return c.json({ error: "Account not found" });
    }

    if (!cookieJar) {
      c.status(500);
      return c.json({ error: "CookieJar not initialized" });
    }

    const body = await c.req.json<{ cookies: string | Record<string, string> }>();
    if (!body.cookies) {
      c.status(400);
      return c.json({
        error: "cookies field is required",
        example: { cookies: "cf_clearance=VALUE; __cf_bm=VALUE" },
      });
    }

    cookieJar.set(id, body.cookies);
    const stored = cookieJar.get(id);
    console.log(`[Cookies] Set ${Object.keys(stored ?? {}).length} cookie(s) for account ${id}`);
    return c.json({ success: true, cookies: stored });
  });

  // Clear cookies for an account
  app.delete("/auth/accounts/:id/cookies", (c) => {
    const id = c.req.param("id");
    if (!pool.getEntry(id)) {
      c.status(404);
      return c.json({ error: "Account not found" });
    }
    cookieJar?.clear(id);
    return c.json({ success: true });
  });

  return app;
}
