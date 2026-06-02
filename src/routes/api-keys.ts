/**
 * API key management routes.
 * CRUD + import/export + catalog for third-party provider API keys.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { API_KEY_CAPABILITIES, API_KEY_WIRES } from "../auth/api-key-pool.js";
import type { ApiKeyEntry, ApiKeyPool } from "../auth/api-key-pool.js";
import { ApiKeyModelCache, ProviderModelFetchError } from "../auth/api-key-model-cache.js";

const VALID_PROVIDERS = ["anthropic", "openai", "gemini", "openrouter", "custom"] as const;
const ModelsSchema = z.array(z.string().trim().min(1)).min(1).transform((models) => [...new Set(models)]);
const CapabilitiesSchema = z.array(z.enum(API_KEY_CAPABILITIES)).min(1).transform((capabilities) => [...new Set(capabilities)]).optional();
const WireSchema = z.enum(API_KEY_WIRES).optional();

const ApiKeyBindingSchema = z.object({
  provider: z.enum(VALID_PROVIDERS),
  models: ModelsSchema,
  apiKey: z.string().min(1),
  baseUrl: z.string().url().optional(),
  label: z.string().max(64).nullable().optional(),
  capabilities: CapabilitiesSchema,
  wire: WireSchema,
}).refine(
  (d) => d.provider !== "custom" || Boolean(d.baseUrl),
  { message: "baseUrl is required for custom providers" },
);

const FetchProviderModelsSchema = z.object({
  provider: z.enum(VALID_PROVIDERS),
  apiKey: z.string().trim().min(1),
  baseUrl: z.string().trim().url().optional(),
}).refine(
  (d) => d.provider !== "custom" || Boolean(d.baseUrl),
  { message: "baseUrl is required for custom providers" },
);

const BulkImportSchema = z.object({
  keys: z.array(ApiKeyBindingSchema).min(1),
});

type ApiKeyBindingInput = z.infer<typeof ApiKeyBindingSchema>;

function addEntries(pool: ApiKeyPool, items: ApiKeyBindingInput[]): {
  added: number;
  failed: number;
  errors: string[];
  keys: ApiKeyEntry[];
} {
  const keys: ApiKeyEntry[] = [];
  const errors: string[] = [];

  for (const item of items) {
    for (const model of item.models) {
      try {
        keys.push(pool.add({
          provider: item.provider,
          model,
          apiKey: item.apiKey,
          baseUrl: item.baseUrl,
          label: item.label,
          capabilities: item.capabilities,
          wire: item.wire,
        }));
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
  }

  return { added: keys.length, failed: errors.length, errors, keys };
}

function toImportableEntries<T extends { model?: string }>(items: T[]): Array<Omit<T, "model"> & { models: string[] }> {
  return items.map(({ model, ...rest }) => ({
    ...rest,
    models: model ? [model] : [],
  }));
}

const LabelSchema = z.object({ label: z.string().max(64).nullable() });
const StatusSchema = z.object({ status: z.enum(["active", "disabled"]) });
const BatchDeleteSchema = z.object({ ids: z.array(z.string()).min(1) });

async function parseJsonRequest<T>(c: Context, schema: z.ZodSchema<T>): Promise<
  { ok: true; data: T } | { ok: false; response: Response }
> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    c.status(400);
    return { ok: false, response: c.json({ error: "Malformed JSON request body" }) };
  }

  const result = schema.safeParse(body);
  if (!result.success) {
    c.status(400);
    return { ok: false, response: c.json({ error: "Invalid request", details: result.error.issues }) };
  }

  return { ok: true, data: result.data };
}

export function createApiKeyRoutes(pool: ApiKeyPool, modelCache = new ApiKeyModelCache()): Hono {
  const app = new Hono();

  // ── Catalog (predefined models) ──────────────────────────────

  app.get("/auth/api-keys/catalog", (c) => {
    return c.json({ catalog: modelCache.getCatalogWithCachedModels() });
  });

  // ── List ──────────────────────────────────────────────────────

  app.get("/auth/api-keys", (c) => {
    return c.json({ keys: pool.exportAll(false) });
  });

  // ── Fetch provider models ──────────────────────────────────────

  app.post("/auth/api-keys/models", async (c) => {
    const parsed = await parseJsonRequest(c, FetchProviderModelsSchema);
    if (!parsed.ok) return parsed.response;

    try {
      const models = await modelCache.fetchModels(parsed.data);
      return c.json({ models });
    } catch (err) {
      if (err instanceof ProviderModelFetchError) {
        if (err.kind === "unauthorized") {
          c.status(401);
          return c.json({ error: "Failed to fetch models: unauthorized" });
        }
        c.status(502);
        return c.json({ error: err.message });
      }
      c.status(502);
      return c.json({ error: "Failed to reach provider" });
    }
  });

  // ── Export (full keys for re-import) ──────────────────────────

  app.get("/auth/api-keys/export", (c) => {
    return c.json({ keys: toImportableEntries(pool.exportForReimport()) });
  });

  // ── Import (bulk) ─────────────────────────────────────────────

  app.post("/auth/api-keys/import", async (c) => {
    const parsed = await parseJsonRequest(c, BulkImportSchema);
    if (!parsed.ok) return parsed.response;
    const result = addEntries(pool, parsed.data.keys);
    return c.json({ success: true, added: result.added, failed: result.failed, errors: result.errors });
  });

  // ── Add single ────────────────────────────────────────────────

  app.post("/auth/api-keys", async (c) => {
    const parsed = await parseJsonRequest(c, ApiKeyBindingSchema);
    if (!parsed.ok) return parsed.response;
    const result = addEntries(pool, [parsed.data]);
    return c.json({
      success: true,
      added: result.added,
      failed: result.failed,
      keys: result.keys.map((entry) => ({ ...entry, apiKey: maskKey(entry.apiKey) })),
    });
  });

  // ── Batch delete ──────────────────────────────────────────────

  app.post("/auth/api-keys/batch-delete", async (c) => {
    const parsed = await parseJsonRequest(c, BatchDeleteSchema);
    if (!parsed.ok) return parsed.response;
    let deleted = 0;
    for (const id of parsed.data.ids) {
      if (pool.remove(id)) deleted++;
    }
    return c.json({ success: true, deleted });
  });

  // ── Per-key routes ────────────────────────────────────────────

  app.delete("/auth/api-keys/:id", (c) => {
    if (!pool.remove(c.req.param("id"))) { c.status(404); return c.json({ error: "API key not found" }); }
    return c.json({ success: true });
  });

  app.patch("/auth/api-keys/:id/label", async (c) => {
    const parsed = await parseJsonRequest(c, LabelSchema);
    if (!parsed.ok) return parsed.response;
    if (!pool.setLabel(c.req.param("id"), parsed.data.label)) { c.status(404); return c.json({ error: "API key not found" }); }
    return c.json({ success: true });
  });

  app.patch("/auth/api-keys/:id/status", async (c) => {
    const parsed = await parseJsonRequest(c, StatusSchema);
    if (!parsed.ok) return parsed.response;
    if (!pool.setStatus(c.req.param("id"), parsed.data.status)) { c.status(404); return c.json({ error: "API key not found" }); }
    return c.json({ success: true });
  });

  return app;
}

function maskKey(key: string): string {
  if (key.length <= 8) return "****";
  return key.slice(0, 4) + "****" + key.slice(-4);
}
