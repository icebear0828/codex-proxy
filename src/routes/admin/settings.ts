import { Hono } from "hono";
import { resolve } from "path";
import { getConfig, reloadAllConfigs, ROTATION_STRATEGIES } from "../../config.js";
import { getConfigDir } from "../../paths.js";
import { mutateYaml } from "../../utils/yaml-mutate.js";

export function createSettingsRoutes(): Hono {
  const app = new Hono();

  // --- Rotation settings ---

  app.get("/admin/rotation-settings", (c) => {
    const config = getConfig();
    return c.json({
      rotation_strategy: config.auth.rotation_strategy,
    });
  });

  app.post("/admin/rotation-settings", async (c) => {
    const config = getConfig();
    const currentKey = config.server.proxy_api_key;

    if (currentKey) {
      const authHeader = c.req.header("Authorization") ?? "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (token !== currentKey) {
        c.status(401);
        return c.json({ error: "Invalid current API key" });
      }
    }

    const body = await c.req.json() as { rotation_strategy?: string };
    const valid: readonly string[] = ROTATION_STRATEGIES;
    if (!body.rotation_strategy || !valid.includes(body.rotation_strategy)) {
      c.status(400);
      return c.json({ error: `rotation_strategy must be one of: ${ROTATION_STRATEGIES.join(", ")}` });
    }

    const configPath = resolve(getConfigDir(), "default.yaml");
    mutateYaml(configPath, (data) => {
      if (!data.auth) data.auth = {};
      (data.auth as Record<string, unknown>).rotation_strategy = body.rotation_strategy;
    });
    reloadAllConfigs();

    const updated = getConfig();
    return c.json({
      success: true,
      rotation_strategy: updated.auth.rotation_strategy,
    });
  });

  // --- General settings ---

  app.get("/admin/settings", (c) => {
    const config = getConfig();
    return c.json({ proxy_api_key: config.server.proxy_api_key });
  });

  app.post("/admin/settings", async (c) => {
    const config = getConfig();
    const currentKey = config.server.proxy_api_key;

    if (currentKey) {
      const authHeader = c.req.header("Authorization") ?? "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (token !== currentKey) {
        c.status(401);
        return c.json({ error: "Invalid current API key" });
      }
    }

    const body = await c.req.json() as { proxy_api_key?: string | null };
    const newKey = body.proxy_api_key === undefined ? currentKey : (body.proxy_api_key || null);

    const configPath = resolve(getConfigDir(), "default.yaml");
    mutateYaml(configPath, (data) => {
      const server = data.server as Record<string, unknown>;
      server.proxy_api_key = newKey;
    });
    reloadAllConfigs();

    return c.json({ success: true, proxy_api_key: newKey });
  });

  // --- Quota settings ---

  app.get("/admin/quota-settings", (c) => {
    const config = getConfig();
    return c.json({
      refresh_interval_minutes: config.quota.refresh_interval_minutes,
      warning_thresholds: config.quota.warning_thresholds,
      skip_exhausted: config.quota.skip_exhausted,
    });
  });

  app.post("/admin/quota-settings", async (c) => {
    const config = getConfig();
    const currentKey = config.server.proxy_api_key;

    if (currentKey) {
      const authHeader = c.req.header("Authorization") ?? "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (token !== currentKey) {
        c.status(401);
        return c.json({ error: "Invalid current API key" });
      }
    }

    const body = await c.req.json() as {
      refresh_interval_minutes?: number;
      warning_thresholds?: { primary?: number[]; secondary?: number[] };
      skip_exhausted?: boolean;
    };

    if (body.refresh_interval_minutes !== undefined) {
      if (!Number.isInteger(body.refresh_interval_minutes) || body.refresh_interval_minutes < 1) {
        c.status(400);
        return c.json({ error: "refresh_interval_minutes must be an integer >= 1" });
      }
    }

    const validateThresholds = (arr?: number[]): boolean => {
      if (!arr) return true;
      return arr.every((v) => Number.isInteger(v) && v >= 1 && v <= 100);
    };
    if (body.warning_thresholds) {
      if (!validateThresholds(body.warning_thresholds.primary) ||
          !validateThresholds(body.warning_thresholds.secondary)) {
        c.status(400);
        return c.json({ error: "Thresholds must be integers between 1 and 100" });
      }
    }

    const configPath = resolve(getConfigDir(), "default.yaml");
    mutateYaml(configPath, (data) => {
      if (!data.quota) data.quota = {};
      const quota = data.quota as Record<string, unknown>;
      if (body.refresh_interval_minutes !== undefined) {
        quota.refresh_interval_minutes = body.refresh_interval_minutes;
      }
      if (body.warning_thresholds) {
        const existing = (quota.warning_thresholds ?? {}) as Record<string, unknown>;
        if (body.warning_thresholds.primary) existing.primary = body.warning_thresholds.primary;
        if (body.warning_thresholds.secondary) existing.secondary = body.warning_thresholds.secondary;
        quota.warning_thresholds = existing;
      }
      if (body.skip_exhausted !== undefined) {
        quota.skip_exhausted = body.skip_exhausted;
      }
    });
    reloadAllConfigs();

    const updated = getConfig();
    return c.json({
      success: true,
      refresh_interval_minutes: updated.quota.refresh_interval_minutes,
      warning_thresholds: updated.quota.warning_thresholds,
      skip_exhausted: updated.quota.skip_exhausted,
    });
  });

  return app;
}
