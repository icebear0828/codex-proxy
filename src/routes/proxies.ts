/**
 * Proxy pool management API routes.
 *
 * GET    /api/proxies              — list all proxies + assignments
 * POST   /api/proxies              — add proxy { name, url }
 * PUT    /api/proxies/:id          — update proxy { name?, url? }
 * DELETE /api/proxies/:id          — remove proxy
 * POST   /api/proxies/:id/check    — health check single proxy
 * POST   /api/proxies/:id/enable   — enable proxy
 * POST   /api/proxies/:id/disable  — disable proxy
 * POST   /api/proxies/check-all    — health check all proxies
 * POST   /api/proxies/assign       — assign proxy to account { accountId, proxyId }
 * DELETE /api/proxies/assign/:accountId — unassign proxy from account
 * PUT    /api/proxies/settings     — update settings { healthCheckIntervalMinutes }
 */

import { Hono } from "hono";
import type { ProxyPool } from "../proxy/proxy-pool.js";
import type { AccountPool } from "../auth/account-pool.js";

export function createProxyRoutes(proxyPool: ProxyPool, accountPool: AccountPool): Hono {
  const app = new Hono();

  // List all proxies + assignments (credentials masked)
  app.get("/api/proxies", (c) => {
    return c.json({
      proxies: proxyPool.getAllMasked(),
      assignments: proxyPool.getAllAssignments(),
      healthCheckIntervalMinutes: proxyPool.getHealthIntervalMinutes(),
    });
  });

  // Add proxy — accepts { name, url } OR { name, protocol, host, port, username?, password? }
  app.post("/api/proxies", async (c) => {
    const body = await c.req.json<{
      name?: string;
      url?: string;
      protocol?: string;
      host?: string;
      port?: string | number;
      username?: string;
      password?: string;
    }>();

    let url = body.url?.trim();

    // Compose URL from separate fields if raw url not provided
    if (!url && body.host) {
      url = composeProxyUrl(body.protocol, body.host, body.port, body.username, body.password);
    }

    if (!url) {
      c.status(400);
      return c.json({ error: "url or host is required" });
    }

    // URL validation + scheme check
    try {
      const parsed = new URL(url);
      const allowed = ["http:", "https:", "socks5:", "socks5h:"];
      if (!allowed.includes(parsed.protocol)) {
        c.status(400);
        return c.json({ error: `Unsupported protocol "${parsed.protocol}". Use http, https, socks5, or socks5h.` });
      }
    } catch {
      c.status(400);
      return c.json({ error: "Invalid proxy URL format" });
    }

    const name = body.name?.trim() || url;
    const id = proxyPool.add(name, url);
    const proxy = proxyPool.getById(id);

    // Restart health check timer if this is the first proxy
    proxyPool.startHealthCheckTimer();

    return c.json({ success: true, proxy });
  });

  // Update proxy
  app.put("/api/proxies/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ name?: string; url?: string }>();

    if (!proxyPool.update(id, body)) {
      c.status(404);
      return c.json({ error: "Proxy not found" });
    }

    return c.json({ success: true, proxy: proxyPool.getById(id) });
  });

  // Remove proxy
  app.delete("/api/proxies/:id", (c) => {
    const id = c.req.param("id");
    if (!proxyPool.remove(id)) {
      c.status(404);
      return c.json({ error: "Proxy not found" });
    }
    return c.json({ success: true });
  });

  // Health check single proxy
  app.post("/api/proxies/:id/check", async (c) => {
    const id = c.req.param("id");
    try {
      const health = await proxyPool.healthCheck(id);
      const proxy = proxyPool.getById(id);
      return c.json({ success: true, proxy, health });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      c.status(404);
      return c.json({ error: msg });
    }
  });

  // Enable proxy
  app.post("/api/proxies/:id/enable", (c) => {
    const id = c.req.param("id");
    if (!proxyPool.enable(id)) {
      c.status(404);
      return c.json({ error: "Proxy not found" });
    }
    return c.json({ success: true, proxy: proxyPool.getById(id) });
  });

  // Disable proxy
  app.post("/api/proxies/:id/disable", (c) => {
    const id = c.req.param("id");
    if (!proxyPool.disable(id)) {
      c.status(404);
      return c.json({ error: "Proxy not found" });
    }
    return c.json({ success: true, proxy: proxyPool.getById(id) });
  });

  // Health check all (no route conflict — different path structure from /:id/*)
  app.post("/api/proxies/check-all", async (c) => {
    await proxyPool.healthCheckAll();
    return c.json({
      success: true,
      proxies: proxyPool.getAllMasked(),
    });
  });

  // Assign proxy to account
  app.post("/api/proxies/assign", async (c) => {
    const body = await c.req.json<{ accountId?: string; proxyId?: string }>();
    const { accountId, proxyId } = body;

    if (!accountId || !proxyId) {
      c.status(400);
      return c.json({ error: "accountId and proxyId are required" });
    }

    // Validate proxyId is a known value
    const validSpecial = ["global", "direct", "auto"];
    if (!validSpecial.includes(proxyId) && !proxyPool.getById(proxyId)) {
      c.status(400);
      return c.json({ error: "Invalid proxyId. Use 'global', 'direct', 'auto', or a valid proxy ID." });
    }

    proxyPool.assign(accountId, proxyId);
    return c.json({
      success: true,
      assignment: { accountId, proxyId },
      displayName: proxyPool.getAssignmentDisplayName(accountId),
    });
  });

  // Unassign proxy from account
  app.delete("/api/proxies/assign/:accountId", (c) => {
    const accountId = c.req.param("accountId");
    proxyPool.unassign(accountId);
    return c.json({ success: true });
  });

  // Update settings
  app.put("/api/proxies/settings", async (c) => {
    const body = await c.req.json<{ healthCheckIntervalMinutes?: number }>();
    if (typeof body.healthCheckIntervalMinutes === "number") {
      proxyPool.setHealthIntervalMinutes(body.healthCheckIntervalMinutes);
    }
    return c.json({
      success: true,
      healthCheckIntervalMinutes: proxyPool.getHealthIntervalMinutes(),
    });
  });

  // ── Bulk Assignment Endpoints ────────────────────────────────────

  /** Check if a proxyId is valid (special keyword or existing proxy). */
  const isValidProxyId = (proxyId: string): boolean =>
    ["global", "direct", "auto"].includes(proxyId) || !!proxyPool.getById(proxyId);

  // List all accounts with their proxy assignments
  app.get("/api/proxies/assignments", (c) => {
    const accounts = accountPool.getAccounts().map((a) => ({
      id: a.id,
      email: a.email,
      status: a.status,
      proxyId: proxyPool.getAssignment(a.id),
      proxyName: proxyPool.getAssignmentDisplayName(a.id),
    }));

    return c.json({
      accounts,
      proxies: proxyPool.getAllMasked(),
    });
  });

  // Bulk assign proxies to accounts
  app.post("/api/proxies/assign-bulk", async (c) => {
    const body = await c.req.json<{
      assignments?: Array<{ accountId: string; proxyId: string }>;
    }>();

    if (!Array.isArray(body.assignments) || body.assignments.length === 0) {
      c.status(400);
      return c.json({ error: "assignments array is required and must not be empty" });
    }

    for (const { proxyId } of body.assignments) {
      if (!isValidProxyId(proxyId)) {
        c.status(400);
        return c.json({ error: `Invalid proxyId: "${proxyId}". Use 'global', 'direct', 'auto', or a valid proxy ID.` });
      }
    }

    proxyPool.bulkAssign(body.assignments);
    return c.json({ success: true, applied: body.assignments.length });
  });

  // Assign by rule (e.g. round-robin distribution)
  app.post("/api/proxies/assign-rule", async (c) => {
    const body = await c.req.json<{
      accountIds?: string[];
      rule?: string;
      targetProxyIds?: string[];
    }>();

    if (!Array.isArray(body.accountIds) || body.accountIds.length === 0) {
      c.status(400);
      return c.json({ error: "accountIds array is required" });
    }
    if (!Array.isArray(body.targetProxyIds) || body.targetProxyIds.length === 0) {
      c.status(400);
      return c.json({ error: "targetProxyIds array is required" });
    }
    if (body.rule !== "round-robin") {
      c.status(400);
      return c.json({ error: `Unsupported rule: "${body.rule ?? ""}". Supported: "round-robin".` });
    }

    for (const pid of body.targetProxyIds) {
      if (!isValidProxyId(pid)) {
        c.status(400);
        return c.json({ error: `Invalid targetProxyId: "${pid}"` });
      }
    }

    // Distribute accounts evenly across target proxies
    const assignments: Array<{ accountId: string; proxyId: string }> = [];
    for (let i = 0; i < body.accountIds.length; i++) {
      assignments.push({
        accountId: body.accountIds[i],
        proxyId: body.targetProxyIds[i % body.targetProxyIds.length],
      });
    }

    proxyPool.bulkAssign(assignments);
    return c.json({ success: true, applied: assignments.length, assignments });
  });

  // Export assignments (by email for portability)
  app.get("/api/proxies/assignments/export", (c) => {
    const allAssignments = proxyPool.getAllAssignments();
    const emailMap = new Map(accountPool.getAccounts().map((a) => [a.id, a.email]));

    const exported = allAssignments
      .map((a) => ({
        email: emailMap.get(a.accountId) ?? null,
        proxyId: a.proxyId,
      }))
      .filter((a): a is { email: string; proxyId: string } => a.email !== null);

    return c.json({ assignments: exported });
  });

  // Import assignments preview (does NOT apply)
  app.post("/api/proxies/assignments/import", async (c) => {
    const body = await c.req.json<{
      assignments?: Array<{ email: string; proxyId: string }>;
    }>();

    if (!Array.isArray(body.assignments)) {
      c.status(400);
      return c.json({ error: "assignments array is required" });
    }

    const emailToAccount = new Map(
      accountPool.getAccounts()
        .filter((a) => a.email !== null)
        .map((a) => [a.email, a] as const),
    );

    const changes: Array<{
      email: string;
      accountId: string;
      from: string;
      to: string;
    }> = [];
    let unchanged = 0;

    for (const { email, proxyId } of body.assignments) {
      const account = emailToAccount.get(email);
      if (!account) continue; // skip unknown emails

      const currentProxyId = proxyPool.getAssignment(account.id);
      if (currentProxyId === proxyId) {
        unchanged++;
      } else {
        changes.push({
          email,
          accountId: account.id,
          from: currentProxyId,
          to: proxyId,
        });
      }
    }

    return c.json({ changes, unchanged });
  });

  // Apply imported assignments (same as bulk assign)
  app.post("/api/proxies/assignments/apply", async (c) => {
    const body = await c.req.json<{
      assignments?: Array<{ accountId: string; proxyId: string }>;
    }>();

    if (!Array.isArray(body.assignments) || body.assignments.length === 0) {
      c.status(400);
      return c.json({ error: "assignments array is required and must not be empty" });
    }

    for (const { proxyId } of body.assignments) {
      if (!isValidProxyId(proxyId)) {
        c.status(400);
        return c.json({ error: `Invalid proxyId: "${proxyId}"` });
      }
    }

    proxyPool.bulkAssign(body.assignments);
    return c.json({ success: true, applied: body.assignments.length });
  });

  return app;
}

/** Compose a proxy URL from separate fields. */
function composeProxyUrl(
  protocol: string | undefined,
  host: string,
  port: string | number | undefined,
  username: string | undefined,
  password: string | undefined,
): string {
  const scheme = protocol || "http";
  const trimmedHost = host.trim();
  let auth = "";
  if (username) {
    auth = password
      ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
      : `${encodeURIComponent(username)}@`;
  }
  const portSuffix = port ? `:${port}` : "";
  return `${scheme}://${auth}${trimmedHost}${portSuffix}`;
}
