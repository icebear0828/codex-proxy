/**
 * API key management routes.
 * CRUD + import/export + catalog for third-party provider API keys.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { API_KEY_CAPABILITIES } from "../auth/api-key-pool.js";
import type { ApiKeyEntry, ApiKeyPool } from "../auth/api-key-pool.js";
import { PROVIDER_CATALOG } from "../auth/api-key-catalog.js";

const VALID_PROVIDERS = ["anthropic", "openai", "gemini", "openrouter", "custom"] as const;
const ModelsSchema = z.array(z.string().trim().min(1)).min(1).transform((models) => [...new Set(models)]);
const CapabilitiesSchema = z.array(z.enum(API_KEY_CAPABILITIES)).min(1).transform((capabilities) => [...new Set(capabilities)]).optional();

const ApiKeyBindingSchema = z.object({
  provider: z.enum(VALID_PROVIDERS),
  models: ModelsSchema,
  apiKey: z.string().min(1),
  baseUrl: z.string().url().optional(),
  label: z.string().max(64).nullable().optional(),
  capabilities: CapabilitiesSchema,
}).refine(
  (d) => d.provider !== "custom" || Boolean(d.baseUrl),
  { message: "baseUrl is required for custom providers" },
);

const FetchCustomModelsSchema = z.object({
  provider: z.literal("custom"),
  apiKey: z.string().trim().min(1),
  baseUrl: z.string().trim().url(),
});

const BulkImportSchema = z.object({
  keys: z.array(ApiKeyBindingSchema).min(1),
});

type ApiKeyBindingInput = z.infer<typeof ApiKeyBindingSchema>;

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function normalizeFetchedModels(payload: unknown): Array<{ id: string; displayName: string }> {
  if (!payload || typeof payload !== "object" || !("data" in payload) || !Array.isArray(payload.data)) {
    return [];
  }

  const models: Array<{ id: string; displayName: string }> = [];
  for (const item of payload.data) {
    if (!item || typeof item !== "object") continue;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id) continue;
    const displayName = typeof item.name === "string" && item.name.trim()
      ? item.name.trim()
      : id;
    models.push({ id, displayName });
  }

  const deduped = new Map<string, { id: string; displayName: string }>();
  for (const model of models) deduped.set(model.id, model);
  return [...deduped.values()];
}

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

export function createApiKeyRoutes(pool: ApiKeyPool): Hono {
  const app = new Hono();

  // ── Catalog (predefined models) ──────────────────────────────

  app.get("/auth/api-keys/catalog", (c) => {
    return c.json({ catalog: PROVIDER_CATALOG });
  });

  // ── List ──────────────────────────────────────────────────────

  app.get("/auth/api-keys", (c) => {
    return c.json({ keys: pool.exportAll(false) });
  });

  // ── Fetch custom provider models ───────────────────────────────

  app.post("/auth/api-keys/models", async (c) => {
    const parsed = await parseJsonRequest(c, FetchCustomModelsSchema);
    if (!parsed.ok) return parsed.response;

    const baseUrl = normalizeBaseUrl(parsed.data.baseUrl);

    try {
      const upstream = await fetch(`${baseUrl}/models`, {
        headers: {
          "Authorization": `Bearer ${parsed.data.apiKey}`,
          "Accept": "application/json",
        },
      });

      if (!upstream.ok) {
        if (upstream.status === 401 || upstream.status === 403) {
          c.status(upstream.status);
          return c.json({ error: "Failed to fetch models: unauthorized" });
        }
        c.status(502);
        return c.json({ error: "Failed to fetch models from provider" });
      }

      const payload = await upstream.json().catch(() => null);
      const models = normalizeFetchedModels(payload);
      if (models.length === 0) {
        c.status(502);
        return c.json({ error: "Provider returned no models" });
      }

      return c.json({ models });
    } catch {
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
