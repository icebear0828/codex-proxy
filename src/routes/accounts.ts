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
import { z } from "zod";
import type { AccountPool } from "../auth/account-pool.js";
import type { RefreshScheduler } from "../auth/refresh-scheduler.js";
import { validateManualToken } from "../auth/chatgpt-oauth.js";
import { startOAuthFlow, refreshAccessToken } from "../auth/oauth-pkce.js";
import { getConfig } from "../config.js";
import { CodexApi } from "../proxy/codex-api.js";
import type { CodexUsageResponse } from "../proxy/codex-api.js";
import type { CodexQuota, AccountInfo } from "../auth/types.js";
import type { CookieJar } from "../proxy/cookie-jar.js";
import type { ProxyPool } from "../proxy/proxy-pool.js";
import { toQuota } from "../auth/quota-utils.js";
import { clearWarnings, getActiveWarnings, getWarningsLastUpdated } from "../auth/quota-warnings.js";

const BatchIdsSchema = z.object({
  ids: z.array(z.string()).min(1),
});

const BatchStatusSchema = z.object({
  ids: z.array(z.string()).min(1),
  status: z.enum(["active", "disabled"]),
});

const LabelSchema = z.object({
  label: z.string().max(64).nullable(),
});

const BulkImportEntrySchema = z.object({
  token: z.string().min(1).optional(),
  refreshToken: z.string().min(1).nullable().optional(),
  label: z.string().max(64).optional(),
}).refine(
  (d) => Boolean(d.token) || Boolean(d.refreshToken),
  { message: "Either token or refreshToken is required" },
);

const BulkImportSchema = z.object({
  accounts: z.array(BulkImportEntrySchema).min(1),
});

export function createAccountRoutes(
  pool: AccountPool,
  scheduler: RefreshScheduler,
  cookieJar?: CookieJar,
  proxyPool?: ProxyPool,
): Hono {
  const app = new Hono();

  /** Helper: build a CodexApi with cookie + proxy support. */
  function makeApi(entryId: string, token: string, accountId: string | null): CodexApi {
    const proxyUrl = proxyPool?.resolveProxyUrl(entryId);
    return new CodexApi(token, accountId, cookieJar, entryId, proxyUrl);
  }

  // Start OAuth flow to add a new account — 302 redirect to Auth0
  app.get("/auth/accounts/login", (c) => {
    const config = getConfig();
    const originalHost = c.req.header("host") || `localhost:${config.server.port}`;
    const { authUrl } = startOAuthFlow(originalHost, "dashboard", pool, scheduler);
    return c.redirect(authUrl);
  });

  // Export accounts (with tokens) for backup/migration
  // ?ids=id1,id2 for selective export; omit for all
  app.get("/auth/accounts/export", (c) => {
    let entries = pool.getAllEntries();
    const idsParam = c.req.query("ids");
    if (idsParam) {
      const idSet = new Set(idsParam.split(",").filter(Boolean));
      entries = entries.filter((e) => idSet.has(e.id));
    }
    return c.json({ accounts: entries });
  });

  // Bulk import accounts from tokens
  app.post("/auth/accounts/import", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      c.status(400);
      return c.json({ error: "Malformed JSON request body" });
    }

    const parsed = BulkImportSchema.safeParse(body);
    if (!parsed.success) {
      c.status(400);
      return c.json({ error: "Invalid request", details: parsed.error.issues });
    }

    let added = 0;
    let updated = 0;
    let failed = 0;
    const errors: string[] = [];
    const existingIds = new Set(pool.getAccounts().map((a) => a.id));

    const config = getConfig();
    const globalProxyUrl = config.tls?.proxy_url ?? null;

    for (const entry of parsed.data.accounts) {
      let token: string;
      let rt: string | null = entry.refreshToken ?? null;

      if (entry.token) {
        // Token provided — validate directly
        const validation = validateManualToken(entry.token);
        if (!validation.valid) {
          failed++;
          errors.push(validation.error ?? "Invalid token");
          continue;
        }
        token = entry.token;
      } else {
        // Refresh-token-only — exchange for access token
        // refine() guarantees refreshToken is truthy when token is absent
        try {
          const tokens = await refreshAccessToken(rt as string, globalProxyUrl);
          const validation = validateManualToken(tokens.access_token);
          if (!validation.valid) {
            failed++;
            errors.push(`Refresh token exchange succeeded but token invalid: ${validation.error}`);
            continue;
          }
          token = tokens.access_token;
          // Prefer the new refresh token if returned
          rt = tokens.refresh_token ?? rt;
        } catch (err) {
          failed++;
          errors.push(`Refresh token exchange failed: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
      }

      const entryId = pool.addAccount(token, rt);
      scheduler.scheduleOne(entryId, token);

      if (entry.label) {
        pool.setLabel(entryId, entry.label);
      }

      if (existingIds.has(entryId)) {
        updated++;
      } else {
        added++;
        existingIds.add(entryId);
      }
    }

    return c.json({ success: true, added, updated, failed, errors });
  });

  // Batch delete accounts
  app.post("/auth/accounts/batch-delete", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      c.status(400);
      return c.json({ error: "Malformed JSON request body" });
    }

    const parsed = BatchIdsSchema.safeParse(body);
    if (!parsed.success) {
      c.status(400);
      return c.json({ error: "Invalid request", details: parsed.error.issues });
    }

    let deleted = 0;
    const notFound: string[] = [];

    for (const id of parsed.data.ids) {
      scheduler.clearOne(id);
      const removed = pool.removeAccount(id);
      if (removed) {
        cookieJar?.clear(id);
        clearWarnings(id);
        deleted++;
      } else {
        notFound.push(id);
      }
    }

    return c.json({ success: true, deleted, notFound });
  });

  // Batch change account status
  app.post("/auth/accounts/batch-status", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      c.status(400);
      return c.json({ error: "Malformed JSON request body" });
    }

    const parsed = BatchStatusSchema.safeParse(body);
    if (!parsed.success) {
      c.status(400);
      return c.json({ error: "Invalid request", details: parsed.error.issues });
    }

    let updated = 0;
    const notFound: string[] = [];

    for (const id of parsed.data.ids) {
      const entry = pool.getEntry(id);
      if (entry) {
        pool.markStatus(id, parsed.data.status);
        updated++;
      } else {
        notFound.push(id);
      }
    }

    return c.json({ success: true, updated, notFound });
  });

  // Update account label
  app.patch("/auth/accounts/:id/label", async (c) => {
    const id = c.req.param("id");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      c.status(400);
      return c.json({ error: "Malformed JSON request body" });
    }

    const parsed = LabelSchema.safeParse(body);
    if (!parsed.success) {
      c.status(400);
      return c.json({ error: "Invalid request", details: parsed.error.issues });
    }

    const ok = pool.setLabel(id, parsed.data.label);
    if (!ok) {
      c.status(404);
      return c.json({ error: "Account not found" });
    }

    return c.json({ success: true });
  });

  // List all accounts
  // ?quota=true  → return cached quota (fast, from background refresh)
  // ?quota=fresh → force live fetch from upstream (manual refresh button)
  app.get("/auth/accounts", async (c) => {
    const quotaParam = c.req.query("quota");
    const wantFresh = quotaParam === "fresh";

    if (wantFresh) {
      // Live fetch quota for every active account in parallel
      const accounts = pool.getAccounts();
      const enriched: AccountInfo[] = await Promise.all(
        accounts.map(async (acct) => {
          if (acct.status !== "active") {
            return {
              ...acct,
              proxyId: proxyPool?.getAssignment(acct.id) ?? "global",
              proxyName: proxyPool?.getAssignmentDisplayName(acct.id) ?? "Global Default",
            };
          }

          const entry = pool.getEntry(acct.id);
          if (!entry) {
            return {
              ...acct,
              proxyId: proxyPool?.getAssignment(acct.id) ?? "global",
              proxyName: proxyPool?.getAssignmentDisplayName(acct.id) ?? "Global Default",
            };
          }

          try {
            const api = makeApi(acct.id, entry.token, entry.accountId);
            const usage = await api.getUsage();
            const quota = toQuota(usage);
            // Cache the fresh quota
            pool.updateCachedQuota(acct.id, quota);
            // Sync rate limit window — auto-reset local counters on window rollover
            const resetAt = usage.rate_limit.primary_window?.reset_at ?? null;
            const windowSec = usage.rate_limit.primary_window?.limit_window_seconds ?? null;
            pool.syncRateLimitWindow(acct.id, resetAt, windowSec);
            // Re-read usage after potential reset
            const freshAcct = pool.getAccounts().find((a) => a.id === acct.id) ?? acct;
            return {
              ...freshAcct,
              quota,
              proxyId: proxyPool?.getAssignment(acct.id) ?? "global",
              proxyName: proxyPool?.getAssignmentDisplayName(acct.id) ?? "Global Default",
            };
          } catch {
            return {
              ...acct,
              proxyId: proxyPool?.getAssignment(acct.id) ?? "global",
              proxyName: proxyPool?.getAssignmentDisplayName(acct.id) ?? "Global Default",
            };
          }
        }),
      );
      return c.json({ accounts: enriched });
    }

    // Default: return accounts with cached quota (populated by toInfo())
    const accounts = pool.getAccounts();
    const enriched = accounts.map((acct) => ({
      ...acct,
      proxyId: proxyPool?.getAssignment(acct.id) ?? "global",
      proxyName: proxyPool?.getAssignmentDisplayName(acct.id) ?? "Global Default",
    }));
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
    clearWarnings(id);
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

  // ── Quota warnings ──────────────────────────────────────────────

  app.get("/auth/quota/warnings", (c) => {
    return c.json({
      warnings: getActiveWarnings(),
      updatedAt: getWarningsLastUpdated(),
    });
  });

  return app;
}
