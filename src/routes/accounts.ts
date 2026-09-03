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
import type { ImportEntry } from "../services/account-import.js";
import { discoverCodexAccountIdentity } from "../services/account-identity-resolver.js";
import { AccountQueryService } from "../services/account-query.js";
import { AccountMutationService } from "../services/account-mutation.js";
import { FallbackUpstreamStore } from "../auth/fallback-upstream.js";
import { getFallbackActivity } from "../auth/fallback-state.js";
import { getProxyUrl as getRuntimeProxyUrl } from "../tls/proxy.js";
import {
  buildAccountExportPayload,
  parseAccountExportFormat,
  parseAccountImportPayload,
  parseAccountImportText,
} from "../services/account-transfer-formats.js";

const BatchIdsSchema = z.object({ ids: z.array(z.string()).min(1) });
const HealthCheckSchema = z.object({
  ids: z.array(z.string()).min(1).optional(),
  stagger_ms: z.number().int().min(500).max(30000).optional(),
  concurrency: z.number().int().min(1).max(10).optional(),
}).optional();
const BatchStatusSchema = z.object({ ids: z.array(z.string()).min(1), status: z.enum(["active", "disabled"]) });
const LabelSchema = z.object({ label: z.string().max(64).nullable() });
const CodexFingerprintSchema = z.object({ mode: z.enum(["off", "session"]) });
export function createAccountRoutes(pool: AccountPool, scheduler: RefreshScheduler, cookieJar?: CookieJar, proxyPool?: ProxyPool, fallbackUpstream?: FallbackUpstreamStore): Hono {
  const app = new Hono();
  const importSvc = new AccountImportService(pool, scheduler, {
    validateToken: validateManualToken,
    refreshToken: refreshAccessToken,
    // Use the process-level resolved proxy (configured or auto-detected), not
    // only config.tls.proxy_url. Passing null would force direct transport and
    // bypass the Clash proxy selected during startup.
    getProxyUrl: getRuntimeProxyUrl,
    discoverIdentity: (token, metadata, options) =>
      discoverCodexAccountIdentity(token, metadata, {
        proxyUrl: options.proxyUrl,
        accountIdHint: options.accountIdHint,
      }),
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
    const format = parseAccountExportFormat(c.req.query("format"));
    if (!format) {
      c.status(400);
      return c.json({ error: "Unsupported export format" });
    }
    return c.json(buildAccountExportPayload(querySvc.exportFull(ids), format));
  });

  app.post("/auth/accounts/import", async (c) => {
    const contentType = c.req.header("content-type") ?? "";
    let entries: ImportEntry[];
    if (contentType.includes("text/plain")) {
      entries = parseAccountImportText(await c.req.text());
    } else {
      const body = await c.req.json();
      entries = parseAccountImportPayload(body);
    }
    if (entries.length === 0) {
      c.status(400);
      return c.json({ error: "Invalid request", details: [{ message: "No importable accounts found" }] });
    }
    return c.json({ success: true, ...(await importSvc.importMany(entries)) });
  });

  app.post("/auth/accounts/batch-delete", async (c) => {
    const body = await c.req.json();
    const parsed = BatchIdsSchema.safeParse(body);
    if (!parsed.success) { c.status(400); return c.json({ error: "Invalid request", details: parsed.error.issues }); }
    return c.json({ success: true, ...mutationSvc.deleteBatch(parsed.data.ids) });
  });

  app.post("/auth/accounts/batch-status", async (c) => {
    const body = await c.req.json();
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
    const body = await c.req.json();
    const parsed = LabelSchema.safeParse(body);
    if (!parsed.success) { c.status(400); return c.json({ error: "Invalid request", details: parsed.error.issues }); }
    if (!pool.setLabel(c.req.param("id"), parsed.data.label)) { c.status(404); return c.json({ error: "Account not found" }); }
    return c.json({ success: true });
  });

  app.patch("/auth/accounts/:id/codex-fingerprint", async (c) => {
    const body = await c.req.json();
    const parsed = CodexFingerprintSchema.safeParse(body);
    if (!parsed.success) { c.status(400); return c.json({ error: "Invalid request", details: parsed.error.issues }); }
    if (!pool.setCodexFingerprintMode(c.req.param("id"), parsed.data.mode)) {
      c.status(404);
      return c.json({ error: "Account not found" });
    }
    return c.json({ success: true, mode: parsed.data.mode });
  });

  app.get("/auth/accounts", (c) => {
    const accounts = querySvc.listFresh();
    return c.json({
      accounts,
      persistence_health: pool.getPersistenceHealth(),
      fallback_upstream: fallbackUpstream?.getPublic() ?? null,
    });
  });

  // ── Fallback upstream apikey (single, last-resort) ─────────────

  const FallbackUpstreamSchema = z.object({
    baseUrl: z.string().trim().min(1, "baseUrl is required"),
    apiKey: z.string().trim().min(1, "apiKey is required"),
  });

  // Update requires a (possibly unchanged) baseUrl — store.update() cannot
  // update the apiKey alone — and an empty apiKey means "keep the existing key".
  const FallbackUpstreamUpdateSchema = z.object({
    baseUrl: z.string().trim().min(1, "baseUrl is required"),
    apiKey: z.string().trim().optional(),
  });

  app.get("/auth/fallback-upstream", (c) => {
    return c.json({
      configured: fallbackUpstream?.isConfigured() ?? false,
      config: fallbackUpstream?.getPublic() ?? null,
      active: getFallbackActivity().active,
    });
  });

  // Lightweight poll target for the dashboard fallback indicator — lets the
  // UI flash the "fallback" badge while requests are being served by a backup
  // account / fallback upstream and revert once they stop.
  app.get("/auth/fallback-upstream/status", (c) => {
    return c.json(getFallbackActivity());
  });

  app.post("/auth/fallback-upstream", async (c) => {
    if (!fallbackUpstream) { c.status(500); return c.json({ error: "Fallback upstream store not initialized" }); }
    const body = await c.req.json().catch(() => null);
    const parsed = FallbackUpstreamSchema.safeParse(body);
    if (!parsed.success) { c.status(400); return c.json({ error: "Invalid request", details: parsed.error.issues }); }
    const result = fallbackUpstream.set(parsed.data.baseUrl, parsed.data.apiKey);
    if (!result.ok) { c.status(409); return c.json({ error: result.error }); }
    return c.json({ success: true, config: fallbackUpstream.getPublic() });
  });

  app.put("/auth/fallback-upstream", async (c) => {
    if (!fallbackUpstream) { c.status(500); return c.json({ error: "Fallback upstream store not initialized" }); }
    const body = await c.req.json().catch(() => null);
    const parsed = FallbackUpstreamUpdateSchema.safeParse(body);
    if (!parsed.success) { c.status(400); return c.json({ error: "Invalid request", details: parsed.error.issues }); }
    const result = fallbackUpstream.update(parsed.data.baseUrl, parsed.data.apiKey ?? "");
    if (!result.ok) { c.status(404); return c.json({ error: result.error }); }
    return c.json({ success: true, config: fallbackUpstream.getPublic() });
  });

  app.delete("/auth/fallback-upstream", (c) => {
    if (!fallbackUpstream) { c.status(500); return c.json({ error: "Fallback upstream store not initialized" }); }
    if (!fallbackUpstream.isConfigured()) { c.status(404); return c.json({ error: "Fallback upstream not configured" }); }
    fallbackUpstream.clear();
    return c.json({ success: true });
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
      const quota = toQuota(usage);
      // Persist the fresh quota so the dashboard reflects upstream reality
      // (especially after OpenAI does a window reset / promo refresh) without
      // waiting for the next proxied /codex/responses request to passively
      // refill cachedQuota via response headers. Also the only path that
      // carries the credits block — the header path doesn't include it.
      pool.updateCachedQuota(id, quota);
      return c.json({ quota, raw: usage });
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

  app.get("/auth/accounts/:id/reset-credits", async (c) => {
    const id = c.req.param("id");
    const entry = pool.getEntry(id);
    if (!entry) { c.status(404); return c.json({ error: "Account not found" }); }
    if (entry.status !== "active") { c.status(409); return c.json({ error: `Account is ${entry.status}, cannot query reset credits` }); }
    try {
      const api = new CodexApi(entry.token, entry.accountId, cookieJar, id, proxyPool?.resolveProxyUrl(id));
      const resetCredits = await api.getResetCredits();
      if (typeof resetCredits.available_count === "number" && entry.cachedQuota) {
        pool.updateCachedQuota(id, { ...entry.cachedQuota, reset_credits_available: resetCredits.available_count });
      }
      return c.json(resetCredits);
    } catch (err) {
      if (isTokenInvalidError(err)) {
        pool.markStatus(id, "expired");
      } else if (isBanError(err)) {
        pool.markStatus(id, "banned");
      }
      const detail = err instanceof Error ? err.message : String(err);
      c.status(502);
      return c.json({ error: "Failed to fetch reset credits from Codex API", detail });
    }
  });

  // H1: per-account cooldown map to prevent rapid re-use of the consume endpoint.
  // The consume action is irreversible — a 30 s gate is the minimum viable protection.
  const consumeCooldowns = new Map<string, number>();
  const CONSUME_COOLDOWN_MS = 30_000;

  app.post("/auth/accounts/:id/reset-credits/consume", async (c) => {
    const id = c.req.param("id");
    const entry = pool.getEntry(id);
    if (!entry) { c.status(404); return c.json({ error: "Account not found" }); }
    if (entry.status !== "active") { c.status(409); return c.json({ error: `Account is ${entry.status}, cannot consume reset credits` }); }

    // H1: enforce cooldown
    const lastConsumed = consumeCooldowns.get(id) ?? 0;
    const msRemaining = lastConsumed + CONSUME_COOLDOWN_MS - Date.now();
    if (msRemaining > 0) {
      c.status(429);
      return c.json({ error: `Reset credit already consumed recently. Try again in ${Math.ceil(msRemaining / 1000)}s.` });
    }

    // H2: validate redeem_request_id is a UUID if provided
    let body: { redeem_request_id?: string } | undefined;
    try {
      body = await c.req.json<{ redeem_request_id?: string }>();
    } catch {
      body = undefined;
    }
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (body?.redeem_request_id !== undefined && body.redeem_request_id !== null) {
      if (typeof body.redeem_request_id !== "string" || !UUID_RE.test(body.redeem_request_id)) {
        c.status(400);
        return c.json({ error: "redeem_request_id must be a valid UUID v4 string" });
      }
    }

    try {
      const api = new CodexApi(entry.token, entry.accountId, cookieJar, id, proxyPool?.resolveProxyUrl(id));
      // C1: consume first; record cooldown immediately on success.
      await api.consumeResetCredit(body?.redeem_request_id);
      consumeCooldowns.set(id, Date.now());

      // C1: quota refresh is best-effort — a failure here must NOT make consume appear to fail.
      // The credit is already spent. We refresh the cache silently and return success regardless.
      // H3: do not expose raw usage response to callers.
      let quota = pool.getEntry(id)?.cachedQuota ?? null;
      try {
        const usage = await api.getUsage();
        quota = toQuota(usage);
        pool.updateCachedQuota(id, quota);
      } catch {
        // quota cache not updated — caller can refresh manually via GET /auth/accounts/:id/quota
        const currentQuota = pool.getEntry(id)?.cachedQuota;
        if (currentQuota?.reset_credits_available && currentQuota.reset_credits_available > 0) {
          quota = { ...currentQuota, reset_credits_available: currentQuota.reset_credits_available - 1 };
          pool.updateCachedQuota(id, quota);
        }
      }
      return c.json({ success: true, quota });
    } catch (err) {
      if (isTokenInvalidError(err)) {
        pool.markStatus(id, "expired");
      } else if (isBanError(err)) {
        pool.markStatus(id, "banned");
      }
      const detail = err instanceof Error ? err.message : String(err);
      c.status(502);
      return c.json({ error: "Failed to consume reset credit from Codex API", detail });
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
