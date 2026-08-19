import { Hono } from "hono";
import { z } from "zod";
import type { ClientKeyPool } from "../../auth/client-key-pool.js";
import { getConfig } from "../../config.js";
import { extractProxyApiKey } from "../../utils/extract-api-key.js";
import { validateSession } from "../../auth/dashboard-session.js";
import { parseSessionCookie } from "../../utils/parse-cookie.js";
import { safeEqual } from "../../auth/safe-equal.js";

// ISO 8601 validation schema for expires_at
const IsoDatetimeSchema = z.string().refine(
  (val) => {
    const timestamp = Date.parse(val);
    return Number.isFinite(timestamp);
  },
  { message: "Invalid ISO datetime string" },
);

const CreateClientKeySchema = z.object({
  name: z.string().min(1, "Name is required"),
  key: z.string().min(1).nullable().optional(),
  expires_at: IsoDatetimeSchema.nullable().optional(),
  max_budget_usd: z.number().positive().nullable().optional(),
  max_tokens: z.number().int().positive().nullable().optional(),
  max_concurrency: z.number().int().positive().nullable().optional(),
  allowed_models: z.array(z.string()).nullable().optional(),
  default_tools: z.array(z.string()).nullable().optional(),
});

const UpdateClientKeySchema = z.object({
  name: z.string().min(1).optional(),
  expires_at: IsoDatetimeSchema.nullable().optional(),
  max_budget_usd: z.number().positive().nullable().optional(),
  max_tokens: z.number().int().positive().nullable().optional(),
  max_concurrency: z.number().int().positive().nullable().optional(),
  allowed_models: z.array(z.string()).nullable().optional(),
  default_tools: z.array(z.string()).nullable().optional(),
  status: z.enum(["active", "disabled"]).optional(),
});

function isAuthorizedAdmin(c: import("hono").Context, getMaster: () => string | null): { authorized: boolean; statusCode: number; error: string } {
  const masterKey = getMaster();

  // 1. Valid dashboard session cookie
  const sessionId = parseSessionCookie(c.req.header("cookie"));
  if (sessionId && validateSession(sessionId)) {
    return { authorized: true, statusCode: 200, error: "" };
  }

  // 2. Check if master key is configured
  if (!masterKey) {
    return {
      authorized: false,
      statusCode: 403,
      error: "Master API key must be configured in server settings to manage client access keys",
    };
  }

  // 3. Bearer Master Key header
  const providedKey = extractProxyApiKey(c);
  if (providedKey && safeEqual(providedKey, masterKey)) {
    return { authorized: true, statusCode: 200, error: "" };
  }

  return {
    authorized: false,
    statusCode: 401,
    error: "Master API key required to manage client access keys",
  };
}

export function createClientKeyAdminRoutes(
  clientKeyPool: ClientKeyPool,
  getMasterKey?: () => string | null,
): Hono {
  const app = new Hono();
  const getMaster = getMasterKey ?? (() => getConfig().server.proxy_api_key ?? null);

  // Dedicated admin authentication for client keys
  const adminAuthMiddleware: import("hono").MiddlewareHandler = async (c, next) => {
    const check = isAuthorizedAdmin(c, getMaster);
    if (!check.authorized) {
      c.status(check.statusCode as 401 | 403);
      return c.json({ error: check.error });
    }
    return next();
  };

  app.use("/admin/client-keys/*", adminAuthMiddleware);
  app.use("/admin/client-keys", adminAuthMiddleware);

  // GET /admin/client-keys — List all client keys (masked)
  app.get("/admin/client-keys", (c) => {
    const summaries = clientKeyPool.getAllPublicSummaries();
    const activeCount = summaries.filter((k) => k.status === "active").length;
    const totalCost = summaries.reduce((acc, k) => acc + k.used_cost_usd, 0);
    const totalReqs = summaries.reduce((acc, k) => acc + k.request_count, 0);

    return c.json({
      keys: summaries,
      total: summaries.length,
      active: activeCount,
      total_cost_usd: totalCost,
      total_requests: totalReqs,
    });
  });

  // POST /admin/client-keys — Create new client key (returns full key once)
  app.post("/admin/client-keys", async (c) => {
    const body = await c.req.json();
    const parsed = CreateClientKeySchema.safeParse(body);
    if (!parsed.success) {
      c.status(400);
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") });
    }

    try {
      const created = clientKeyPool.createKey(parsed.data);
      return c.json({ success: true, key: created });
    } catch (err) {
      c.status(400);
      return c.json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // PUT /admin/client-keys/:id — Update client key
  app.put("/admin/client-keys/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();
    const parsed = UpdateClientKeySchema.safeParse(body);
    if (!parsed.success) {
      c.status(400);
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") });
    }

    try {
      const updated = clientKeyPool.updateKey(id, parsed.data);
      return c.json({ success: true, key: updated });
    } catch (err) {
      c.status(404);
      return c.json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /admin/client-keys/:id/toggle — Toggle active/disabled
  app.post("/admin/client-keys/:id/toggle", (c) => {
    const id = c.req.param("id");
    try {
      const toggled = clientKeyPool.toggleStatus(id);
      return c.json({ success: true, key: toggled });
    } catch (err) {
      c.status(404);
      return c.json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /admin/client-keys/:id/reset-usage — Reset cost and tokens
  app.post("/admin/client-keys/:id/reset-usage", (c) => {
    const id = c.req.param("id");
    try {
      const reset = clientKeyPool.resetUsage(id);
      return c.json({ success: true, key: reset });
    } catch (err) {
      c.status(404);
      return c.json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // DELETE /admin/client-keys/:id — Delete client key
  app.delete("/admin/client-keys/:id", (c) => {
    const id = c.req.param("id");
    const deleted = clientKeyPool.deleteKey(id);
    if (!deleted) {
      c.status(404);
      return c.json({ error: "Client key not found" });
    }
    return c.json({ success: true });
  });

  // GET /v1/sub-key/info — Client key self-service query (quota & allowed models)
  app.get("/v1/sub-key/info", (c) => {
    const token = extractProxyApiKey(c);
    if (!token) {
      c.status(401);
      return c.json({ error: "Authorization header with client key required" });
    }

    const key = clientKeyPool.getByKey(token);
    if (!key) {
      c.status(404);
      return c.json({ error: "Key not found" });
    }

    const remainingBudgetUsd =
      key.max_budget_usd != null ? Math.max(0, key.max_budget_usd - key.used_cost_usd) : null;
    const remainingTokens =
      key.max_tokens != null ? Math.max(0, key.max_tokens - key.used_tokens) : null;

    return c.json({
      name: key.name,
      status: key.status,
      expires_at: key.expires_at,
      max_budget_usd: key.max_budget_usd,
      used_cost_usd: key.used_cost_usd,
      remaining_budget_usd: remainingBudgetUsd,
      max_tokens: key.max_tokens,
      used_tokens: key.used_tokens,
      remaining_tokens: remainingTokens,
      allowed_models: key.allowed_models,
      request_count: key.request_count,
      last_used_at: key.last_used_at,
    });
  });

  return app;
}
