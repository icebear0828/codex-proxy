/**
 * Admin routes for account keepalive scheduler.
 *
 * GET  /admin/keepalive-status  — current scheduler state + last results
 * POST /admin/keepalive-config  — update account_keepalive config in local.yaml
 * POST /admin/keepalive-run     — trigger an immediate run
 */

import { Hono } from "hono";
import { getConfig, getLocalConfigPath, reloadAllConfigs } from "../../config.js";
import { mutateYaml } from "../../utils/yaml-mutate.js";
import type { KeepaliveScheduler } from "../../auth/keepalive-scheduler.js";

export function createKeepaliveRoutes(scheduler: KeepaliveScheduler): Hono {
  const app = new Hono();

  // Auth guard helper — mirrors pattern in settings.ts
  function checkAuth(authHeader: string | undefined): boolean {
    const key = getConfig().server.proxy_api_key;
    if (!key) return true;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
    return token === key;
  }

  app.get("/admin/keepalive-status", (c) => {
    return c.json(scheduler.getStatus());
  });

  app.post("/admin/keepalive-config", async (c) => {
    if (!checkAuth(c.req.header("Authorization"))) {
      c.status(401);
      return c.json({ error: "Invalid current API key" });
    }

    const body = await c.req.json() as unknown;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      c.status(400);
      return c.json({ error: "Request body must be an object" });
    }
    const config = body as {
      enabled?: unknown;
      mode?: unknown;
      fixed_times?: unknown;
      interval_minutes?: unknown;
      concurrency?: unknown;
      per_account_delay_ms?: unknown;
    };

    if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
      c.status(400);
      return c.json({ error: "enabled must be a boolean" });
    }
    if (config.mode !== undefined && config.mode !== "fixed_times" && config.mode !== "interval") {
      c.status(400);
      return c.json({ error: "mode must be 'fixed_times' or 'interval'" });
    }
    if (config.fixed_times !== undefined) {
      if (!Array.isArray(config.fixed_times)) {
        c.status(400);
        return c.json({ error: "fixed_times must be an array" });
      }
      const bad = config.fixed_times.find(
        (time) => typeof time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time),
      );
      if (bad !== undefined) {
        c.status(400);
        return c.json({ error: "fixed_times entries must be valid 24-hour HH:mm values" });
      }
    }
    if (config.interval_minutes !== undefined && config.interval_minutes !== null) {
      if (!Number.isSafeInteger(config.interval_minutes) || (config.interval_minutes as number) <= 0) {
        c.status(400);
        return c.json({ error: "interval_minutes must be a positive integer or null" });
      }
    }
    if (config.concurrency !== undefined) {
      if (!Number.isInteger(config.concurrency) || (config.concurrency as number) < 1 || (config.concurrency as number) > 20) {
        c.status(400);
        return c.json({ error: "concurrency must be an integer between 1 and 20" });
      }
    }
    if (config.per_account_delay_ms !== undefined) {
      if (!Number.isSafeInteger(config.per_account_delay_ms) || (config.per_account_delay_ms as number) < 0 || (config.per_account_delay_ms as number) > 3600000) {
        c.status(400);
        return c.json({ error: "per_account_delay_ms must be an integer between 0 and 3600000" });
      }
    }

    mutateYaml(getLocalConfigPath(), (data) => {
      if (!data.account_keepalive) data.account_keepalive = {};
      const ka = data.account_keepalive as Record<string, unknown>;
      if (config.enabled !== undefined) ka.enabled = config.enabled;
      if (config.mode !== undefined) ka.mode = config.mode;
      if (config.fixed_times !== undefined) ka.fixed_times = config.fixed_times;
      if (config.interval_minutes !== undefined) ka.interval_minutes = config.interval_minutes;
      if (config.concurrency !== undefined) ka.concurrency = config.concurrency;
      if (config.per_account_delay_ms !== undefined) ka.per_account_delay_ms = config.per_account_delay_ms;
    });
    reloadAllConfigs();

    // Restart scheduler with new config
    scheduler.stop();
    scheduler.start();

    return c.json({ success: true, config: getConfig().account_keepalive });
  });

  app.post("/admin/keepalive-run", async (c) => {
    if (!checkAuth(c.req.header("Authorization"))) {
      c.status(401);
      return c.json({ error: "Invalid current API key" });
    }

    const results = await scheduler.runNow();
    return c.json({ success: true, results });
  });

  return app;
}
