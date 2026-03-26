import { Hono } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { getConfig, getLocalConfigPath, reloadAllConfigs, ROTATION_STRATEGIES } from "../../config.js";
import { mutateYaml } from "../../utils/yaml-mutate.js";
import { isLocalhostRequest } from "../../utils/is-localhost.js";

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

    mutateYaml(getLocalConfigPath(), (data) => {
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

    // Prevent remote sessions from clearing the key (would disable login gate)
    if (currentKey && !newKey) {
      const remoteAddr = getConnInfo(c).remote.address ?? "";
      if (!isLocalhostRequest(remoteAddr)) {
        c.status(403);
        return c.json({ error: "Cannot clear API key from remote session — this would disable the login gate" });
      }
    }

    mutateYaml(getLocalConfigPath(), (data) => {
      if (!data.server) data.server = {};
      (data.server as Record<string, unknown>).proxy_api_key = newKey;
    });
    reloadAllConfigs();

    return c.json({ success: true, proxy_api_key: newKey });
  });

  // --- General (server/tls) settings ---

  app.get("/admin/general-settings", (c) => {
    const config = getConfig();
    return c.json({
      port: config.server.port,
      proxy_url: config.tls.proxy_url,
      force_http11: config.tls.force_http11,
      inject_desktop_context: config.model.inject_desktop_context,
      suppress_desktop_directives: config.model.suppress_desktop_directives,
      default_model: config.model.default,
      default_reasoning_effort: config.model.default_reasoning_effort,
      refresh_enabled: config.auth.refresh_enabled,
      refresh_margin_seconds: config.auth.refresh_margin_seconds,
      refresh_concurrency: config.auth.refresh_concurrency,
      auto_update: config.update.auto_update,
    });
  });

  app.post("/admin/general-settings", async (c) => {
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
      port?: number;
      proxy_url?: string | null;
      force_http11?: boolean;
      inject_desktop_context?: boolean;
      suppress_desktop_directives?: boolean;
      default_model?: string;
      default_reasoning_effort?: string;
      refresh_enabled?: boolean;
      refresh_margin_seconds?: number;
      refresh_concurrency?: number;
      auto_update?: boolean;
    };

    // --- validation ---
    if (body.port !== undefined) {
      if (!Number.isInteger(body.port) || body.port < 1 || body.port > 65535) {
        c.status(400);
        return c.json({ error: "port must be an integer between 1 and 65535" });
      }
    }

    if (body.proxy_url !== undefined && body.proxy_url !== null) {
      try {
        new URL(body.proxy_url);
      } catch {
        c.status(400);
        return c.json({ error: "proxy_url must be a valid URL or null" });
      }
    }

    if (body.default_reasoning_effort !== undefined) {
      const validEfforts = ["low", "medium", "high", "xhigh"];
      if (!validEfforts.includes(body.default_reasoning_effort)) {
        c.status(400);
        return c.json({ error: `default_reasoning_effort must be one of: ${validEfforts.join(", ")}` });
      }
    }

    if (body.refresh_margin_seconds !== undefined) {
      if (!Number.isInteger(body.refresh_margin_seconds) || body.refresh_margin_seconds < 0) {
        c.status(400);
        return c.json({ error: "refresh_margin_seconds must be an integer >= 0" });
      }
    }

    if (body.refresh_concurrency !== undefined) {
      if (!Number.isInteger(body.refresh_concurrency) || body.refresh_concurrency < 1) {
        c.status(400);
        return c.json({ error: "refresh_concurrency must be an integer >= 1" });
      }
    }

    const oldPort = config.server.port;
    const oldDefaultModel = config.model.default;

    mutateYaml(getLocalConfigPath(), (data) => {
      if (body.port !== undefined) {
        if (!data.server) data.server = {};
        (data.server as Record<string, unknown>).port = body.port;
      }
      if (body.proxy_url !== undefined) {
        if (!data.tls) data.tls = {};
        (data.tls as Record<string, unknown>).proxy_url = body.proxy_url;
      }
      if (body.force_http11 !== undefined) {
        if (!data.tls) data.tls = {};
        (data.tls as Record<string, unknown>).force_http11 = body.force_http11;
      }
      if (body.inject_desktop_context !== undefined) {
        if (!data.model) data.model = {};
        (data.model as Record<string, unknown>).inject_desktop_context = body.inject_desktop_context;
      }
      if (body.suppress_desktop_directives !== undefined) {
        if (!data.model) data.model = {};
        (data.model as Record<string, unknown>).suppress_desktop_directives = body.suppress_desktop_directives;
      }
      if (body.default_model !== undefined) {
        if (!data.model) data.model = {};
        (data.model as Record<string, unknown>).default = body.default_model;
      }
      if (body.default_reasoning_effort !== undefined) {
        if (!data.model) data.model = {};
        (data.model as Record<string, unknown>).default_reasoning_effort = body.default_reasoning_effort;
      }
      if (body.refresh_enabled !== undefined) {
        if (!data.auth) data.auth = {};
        (data.auth as Record<string, unknown>).refresh_enabled = body.refresh_enabled;
      }
      if (body.refresh_margin_seconds !== undefined) {
        if (!data.auth) data.auth = {};
        (data.auth as Record<string, unknown>).refresh_margin_seconds = body.refresh_margin_seconds;
      }
      if (body.refresh_concurrency !== undefined) {
        if (!data.auth) data.auth = {};
        (data.auth as Record<string, unknown>).refresh_concurrency = body.refresh_concurrency;
      }
      if (body.auto_update !== undefined) {
        if (!data.update) data.update = {};
        (data.update as Record<string, unknown>).auto_update = body.auto_update;
      }
    });
    reloadAllConfigs();

    const updated = getConfig();
    const restartRequired =
      (body.port !== undefined && body.port !== oldPort) ||
      (body.default_model !== undefined && body.default_model !== oldDefaultModel);
    return c.json({
      success: true,
      port: updated.server.port,
      proxy_url: updated.tls.proxy_url,
      force_http11: updated.tls.force_http11,
      inject_desktop_context: updated.model.inject_desktop_context,
      suppress_desktop_directives: updated.model.suppress_desktop_directives,
      default_model: updated.model.default,
      default_reasoning_effort: updated.model.default_reasoning_effort,
      refresh_enabled: updated.auth.refresh_enabled,
      refresh_margin_seconds: updated.auth.refresh_margin_seconds,
      refresh_concurrency: updated.auth.refresh_concurrency,
      auto_update: updated.update.auto_update,
      restart_required: restartRequired,
    });
  });

  // --- Quota settings ---

  app.get("/admin/quota-settings", (c) => {
    const config = getConfig();
    return c.json({
      refresh_interval_minutes: config.quota.refresh_interval_minutes,
      warning_thresholds: config.quota.warning_thresholds,
      skip_exhausted: config.quota.skip_exhausted,
      concurrency: config.quota.concurrency,
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
      concurrency?: number;
    };

    if (body.refresh_interval_minutes !== undefined) {
      if (!Number.isInteger(body.refresh_interval_minutes) || body.refresh_interval_minutes < 0) {
        c.status(400);
        return c.json({ error: "refresh_interval_minutes must be an integer >= 0" });
      }
    }

    if (body.concurrency !== undefined) {
      if (!Number.isInteger(body.concurrency) || body.concurrency < 1) {
        c.status(400);
        return c.json({ error: "concurrency must be an integer >= 1" });
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

    mutateYaml(getLocalConfigPath(), (data) => {
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
      if (body.concurrency !== undefined) {
        quota.concurrency = body.concurrency;
      }
    });
    reloadAllConfigs();

    const updated = getConfig();
    return c.json({
      success: true,
      refresh_interval_minutes: updated.quota.refresh_interval_minutes,
      warning_thresholds: updated.quota.warning_thresholds,
      skip_exhausted: updated.quota.skip_exhausted,
      concurrency: updated.quota.concurrency,
    });
  });

  return app;
}
