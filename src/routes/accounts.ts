/**
 * Account management API routes.
 * Business logic delegated to src/services/account-{import,query,mutation}.ts.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AccountPool } from "../auth/account-pool.js";
import type { RefreshScheduler } from "../auth/refresh-scheduler.js";
import { validateManualToken } from "../auth/chatgpt-oauth.js";
import { startOAuthFlow, refreshAccessToken } from "../auth/oauth-pkce.js";
import { getConfig } from "../config.js";
import { CodexApi } from "../proxy/codex-api.js";
import type { CookieJar } from "../proxy/cookie-jar.js";
import type { ProxyPool } from "../proxy/proxy-pool.js";
import { toQuota } from "../auth/quota-utils.js";
import { isBanError, isTokenInvalidError } from "../proxy/error-classification.js";
import { clearWarnings, getActiveWarnings, getWarningsLastUpdated } from "../auth/quota-warnings.js";
import { probeAccount, batchHealthCheck } from "../auth/health-check.js";
import { AccountImportService } from "../services/account-import.js";
import { AccountQueryService } from "../services/account-query.js";
import { AccountMutationService } from "../services/account-mutation.js";

const BatchIdsSchema = z.object({ ids: z.array(z.string()).min(1) });
const HealthCheckSchema = z.object({
  ids: z.array(z.string()).min(1).optional(),
  stagger_ms: z.number().int().min(500).max(30000).optional(),
  concurrency: z.number().int().min(1).max(10).optional(),
}).optional();
const BatchStatusSchema = z.object({ ids: z.array(z.string()).min(1), status: z.enum(["active", "disabled"]) });
const LabelSchema = z.object({ label: z.string().max(64).nullable() });
const BulkImportEntrySchema = z.object({
  token: z.string().min(1).optional(),
  refreshToken: z.string().min(1).nullable().optional(),
  label: z.string().max(64).nullable().optional(),
}).refine((d) => Boolean(d.token) || Boolean(d.refreshToken), { message: "Either token or refreshToken is required" });
const BulkImportSchema = z.object({ accounts: z.array(BulkImportEntrySchema).min(1) });

export function createAccountRoutes(pool: AccountPool, scheduler: RefreshScheduler, cookieJar?: CookieJar, proxyPool?: ProxyPool): Hono {
  const app = new Hono();
  const importSvc = new AccountImportService(pool, scheduler, {
    validateToken: validateManualToken,
    refreshToken: refreshAccessToken,
    getProxyUrl: () => getConfig().tls?.proxy_url ?? null,
    // Warmup disabled: sending GET /codex/usage immediately after RT exchange
    // triggers OpenAI risk detection and causes account deactivation.
    warmup: undefined,
    // Single-import verification: GET /codex/usage to check deactivated accounts
    // and collect quota data. Only used by importOne (manual add), not batch.
    verifyAccount: async (token, accountId, proxyUrl) => {
      const api = new CodexApi(token, accountId, cookieJar, null, proxyUrl);
      try {
        const usage = await api.getUsage();
        return { ok: true, usage };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.toLowerCase().includes("deactivated")) {
          return { ok: false, error: "Account has been deactivated" };
        }
        // Non-deactivation errors (network, rate-limit) — don't block import
        return { ok: true };
      }
    },
  });
  const querySvc = new AccountQueryService(
    pool,
    proxyPool ? { getAssignment: (id) => proxyPool.getAssignment(id), getAssignmentDisplayName: (id) => proxyPool.getAssignmentDisplayName(id) } : undefined,
  );
  const mutationSvc = new AccountMutationService(pool, {
    clearSchedule: (id) => scheduler.clearOne(id),
    clearCookies: cookieJar ? (id) => cookieJar.clear(id) : undefined,
    clearWarnings,
  });

  app.get("/auth/accounts/login", (c) => {
    const config = getConfig();
    const host = c.req.header("host") || `localhost:${config.server.port}`;
    return c.redirect(startOAuthFlow(host, "dashboard", pool, scheduler).authUrl);
  });

  app.get("/auth/accounts/export", (c) => {
    const ids = c.req.query("ids")?.split(",").filter(Boolean);
    if (c.req.query("format") === "minimal") return c.json({ accounts: querySvc.exportMinimal(ids) });
    return c.json({ accounts: querySvc.exportFull(ids) });
  });

  app.post("/auth/accounts/import", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { c.status(400); return c.json({ error: "Malformed JSON request body" }); }
    const parsed = BulkImportSchema.safeParse(body);
    if (!parsed.success) { c.status(400); return c.json({ error: "Invalid request", details: parsed.error.issues }); }
    return c.json({ success: true, ...(await importSvc.importMany(parsed.data.accounts)) });
  });

  app.post("/auth/accounts/batch-delete", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { c.status(400); return c.json({ error: "Malformed JSON request body" }); }
    const parsed = BatchIdsSchema.safeParse(body);
    if (!parsed.success) { c.status(400); return c.json({ error: "Invalid request", details: parsed.error.issues }); }
    return c.json({ success: true, ...mutationSvc.deleteBatch(parsed.data.ids) });
  });

  app.post("/auth/accounts/batch-status", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { c.status(400); return c.json({ error: "Malformed JSON request body" }); }
    const parsed = BatchStatusSchema.safeParse(body);
    if (!parsed.success) { c.status(400); return c.json({ error: "Invalid request", details: parsed.error.issues }); }
    return c.json({ success: true, ...mutationSvc.setStatusBatch(parsed.data.ids, parsed.data.status) });
  });

  // ── Health check (must be before :id routes) ────────────────────

  app.post("/auth/accounts/health-check", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { body = undefined; }
    const parsed = HealthCheckSchema.safeParse(body);
    if (!parsed.success) { c.status(400); return c.json({ error: "Invalid request", details: parsed.error.issues }); }
    const opts = parsed.data;

    const results = await batchHealthCheck(pool, scheduler, {
      ids: opts?.ids,
      staggerMs: opts?.stagger_ms,
      concurrency: opts?.concurrency,
    }, proxyPool);

    const alive = results.filter((r) => r.result === "alive").length;
    const dead = results.filter((r) => r.result === "dead").length;
    const skipped = results.filter((r) => r.result === "skipped").length;

    return c.json({ summary: { total: results.length, alive, dead, skipped }, results });
  });

  // ── Per-account routes ─────────────────────────────────────────

  app.post("/auth/accounts/:id/refresh", async (c) => {
    const id = c.req.param("id");
    const result = await probeAccount(pool, scheduler, id, proxyPool);
    if (result.result === "skipped" && result.error === "not found") {
      c.status(404);
      return c.json({ error: "Account not found" });
    }
    return c.json(result);
  });

  app.patch("/auth/accounts/:id/label", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { c.status(400); return c.json({ error: "Malformed JSON request body" }); }
    const parsed = LabelSchema.safeParse(body);
    if (!parsed.success) { c.status(400); return c.json({ error: "Invalid request", details: parsed.error.issues }); }
    if (!pool.setLabel(c.req.param("id"), parsed.data.label)) { c.status(404); return c.json({ error: "Account not found" }); }
    return c.json({ success: true });
  });

  app.get("/auth/accounts", async (c) => {
    const accounts = querySvc.listFresh();
    return c.json({ accounts });
  });

  app.post("/auth/accounts", async (c) => {
    const body = await c.req.json<{ token?: string; refreshToken?: string }>();
    const result = await importSvc.importOne(body.token?.trim(), body.refreshToken?.trim());
    if (!result.ok) { c.status(result.kind === "refresh_failed" ? 502 : 400); return c.json({ error: result.error }); }
    return c.json({ success: true, account: result.account });
  });

  app.delete("/auth/accounts/:id", (c) => {
    const { deleted } = mutationSvc.deleteBatch([c.req.param("id")]);
    if (!deleted) { c.status(404); return c.json({ error: "Account not found" }); }
    return c.json({ success: true });
  });

  app.post("/auth/accounts/:id/reset-usage", (c) => {
    if (!pool.resetUsage(c.req.param("id"))) { c.status(404); return c.json({ error: "Account not found" }); }
    return c.json({ success: true });
  });

  app.get("/auth/accounts/:id/quota", async (c) => {
    const id = c.req.param("id");
    const entry = pool.getEntry(id);
    if (!entry) { c.status(404); return c.json({ error: "Account not found" }); }
    if (entry.status !== "active") { c.status(409); return c.json({ error: `Account is ${entry.status}, cannot query quota` }); }
    try {
      const usage = await new CodexApi(entry.token, entry.accountId, cookieJar, id, proxyPool?.resolveProxyUrl(id)).getUsage();
      return c.json({ quota: toQuota(usage), raw: usage });
    } catch (err) {
      // Auto-mark invalidated/banned accounts
      if (isTokenInvalidError(err)) {
        pool.markStatus(id, "expired");
      } else if (isBanError(err)) {
        pool.markStatus(id, "banned");
      }

      const detail = err instanceof Error ? err.message : String(err);
      const isCf = detail.includes("403") || detail.includes("cf_chl");
      c.status(502);
      return c.json({
        error: "Failed to fetch quota from Codex API", detail,
        hint: isCf && !cookieJar?.getCookieHeader(id)
          ? "Cloudflare blocked this request. Set cookies via POST /auth/accounts/:id/cookies with your browser's cf_clearance cookie."
          : undefined,
      });
    }
  });

  app.get("/auth/accounts/:id/cookies", (c) => {
    const id = c.req.param("id");
    if (!pool.getEntry(id)) { c.status(404); return c.json({ error: "Account not found" }); }
    const cookies = cookieJar?.get(id) ?? null;
    return c.json({
      cookies,
      hint: !cookies ? "No cookies set. POST cookies from your browser to bypass Cloudflare. Example: { \"cookies\": \"cf_clearance=VALUE; __cf_bm=VALUE\" }" : undefined,
    });
  });

  app.post("/auth/accounts/:id/cookies", async (c) => {
    const id = c.req.param("id");
    if (!pool.getEntry(id)) { c.status(404); return c.json({ error: "Account not found" }); }
    if (!cookieJar) { c.status(500); return c.json({ error: "CookieJar not initialized" }); }
    const body = await c.req.json<{ cookies: string | Record<string, string> }>();
    if (!body.cookies) { c.status(400); return c.json({ error: "cookies field is required", example: { cookies: "cf_clearance=VALUE; __cf_bm=VALUE" } }); }
    cookieJar.set(id, body.cookies);
    const stored = cookieJar.get(id);
    console.log(`[Cookies] Set ${Object.keys(stored ?? {}).length} cookie(s) for account ${id}`);
    return c.json({ success: true, cookies: stored });
  });

  app.delete("/auth/accounts/:id/cookies", (c) => {
    const id = c.req.param("id");
    if (!pool.getEntry(id)) { c.status(404); return c.json({ error: "Account not found" }); }
    cookieJar?.clear(id);
    return c.json({ success: true });
  });

  app.get("/auth/quota/warnings", (c) => {
    return c.json({ warnings: getActiveWarnings(), updatedAt: getWarningsLastUpdated() });
  });

  return app;
}
