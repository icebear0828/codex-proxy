import { Hono } from "hono";
import { getConfig, getLocalConfigPath, reloadAllConfigs } from "../../config.js";
import { mutateYaml } from "../../utils/yaml-mutate.js";
import { getOllamaBridgeStatusForConfig, restartOllamaBridge } from "../../ollama/server.js";

interface OllamaSettingsBody {
  enabled?: boolean;
  host?: string;
  port?: number;
  version?: string;
  disable_vision?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateBody(body: OllamaSettingsBody): string | null {
  if (body.host !== undefined) {
    const host = body.host.trim();
    if (!host || /\s/.test(host)) {
      return "host must be a non-empty hostname or IP address";
    }
  }
  if (body.port !== undefined) {
    if (!Number.isInteger(body.port) || body.port < 1 || body.port > 65535) {
      return "port must be an integer between 1 and 65535";
    }
  }
  if (body.version !== undefined) {
    const version = body.version.trim();
    if (!version || version.length > 64) {
      return "version must be a non-empty string up to 64 characters";
    }
  }
  return null;
}

function currentSettingsPayload() {
  const config = getConfig();
  return {
    enabled: config.ollama.enabled,
    host: config.ollama.host,
    port: config.ollama.port,
    version: config.ollama.version,
    disable_vision: config.ollama.disable_vision,
  };
}

function currentPayload() {
  const config = getConfig();
  return {
    ...currentSettingsPayload(),
    status: getOllamaBridgeStatusForConfig(config),
  };
}

export function createOllamaAdminRoutes(): Hono {
  const app = new Hono();

  app.get("/admin/ollama-settings", (c) => {
    return c.json(currentPayload());
  });

  app.get("/admin/ollama-status", (c) => {
    return c.json(getOllamaBridgeStatusForConfig(getConfig()));
  });

  app.post("/admin/ollama-settings", async (c) => {
    // Auth is handled at the middleware layer (`src/middleware/dashboard-auth.ts`):
    // all `/admin/*` routes require either a localhost request or a valid
    // dashboard session, matching the convention used by the other admin
    // POSTs (`/admin/quota-settings`, `/admin/rotation-settings`, etc.).
    let parsedBody: unknown;
    try {
      parsedBody = await c.req.json();
    } catch {
      c.status(400);
      return c.json({ error: "Invalid JSON body" });
    }
    if (!isRecord(parsedBody)) {
      c.status(400);
      return c.json({ error: "JSON body must be an object" });
    }

    const body = parsedBody as OllamaSettingsBody;
    const validationError = validateBody(body);
    if (validationError) {
      c.status(400);
      return c.json({ error: validationError });
    }

    mutateYaml(getLocalConfigPath(), (data) => {
      if (!data.ollama) data.ollama = {};
      const ollama = data.ollama as Record<string, unknown>;
      if (body.enabled !== undefined) ollama.enabled = body.enabled;
      if (body.host !== undefined) ollama.host = body.host.trim();
      if (body.port !== undefined) ollama.port = body.port;
      if (body.version !== undefined) ollama.version = body.version.trim();
      if (body.disable_vision !== undefined) ollama.disable_vision = body.disable_vision;
    });
    reloadAllConfigs();
    const status = await restartOllamaBridge(getConfig());

    return c.json({
      success: true,
      ...currentSettingsPayload(),
      status,
    });
  });

  return app;
}
