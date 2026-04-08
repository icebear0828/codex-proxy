/**
 * API key management routes.
 * CRUD + import/export + catalog for third-party provider API keys.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { ApiKeyPool } from "../auth/api-key-pool.js";
import { PROVIDER_CATALOG, isBuiltinProvider } from "../auth/api-key-catalog.js";
import type { ApiKeyProvider } from "../auth/api-key-catalog.js";

const VALID_PROVIDERS = ["anthropic", "openai", "gemini", "openrouter", "custom"] as const;

const AddKeySchema = z.object({
  provider: z.enum(VALID_PROVIDERS),
  model: z.string().min(1),
  apiKey: z.string().min(1),
  baseUrl: z.string().url().optional(),
  label: z.string().max(64).nullable().optional(),
}).refine(
  (d) => d.provider !== "custom" || Boolean(d.baseUrl),
  { message: "baseUrl is required for custom providers" },
);

const BulkImportEntrySchema = z.object({
  provider: z.enum(VALID_PROVIDERS),
  model: z.string().min(1),
  apiKey: z.string().min(1),
  baseUrl: z.string().url().optional(),
  label: z.string().max(64).nullable().optional(),
}).refine(
  (d) => d.provider !== "custom" || Boolean(d.baseUrl),
  { message: "baseUrl is required for custom providers" },
);

const BulkImportSchema = z.object({
  keys: z.array(BulkImportEntrySchema).min(1),
});

const LabelSchema = z.object({ label: z.string().max(64).nullable() });
const StatusSchema = z.object({ status: z.enum(["active", "disabled"]) });
const BatchDeleteSchema = z.object({ ids: z.array(z.string()).min(1) });

function parseBody<T>(schema: z.ZodSchema<T>) {
  return async (body: unknown): Promise<{ ok: true; data: T } | { ok: false; error: z.ZodError }> => {
    const result = schema.safeParse(body);
    if (!result.success) return { ok: false, error: result.error };
    return { ok: true, data: result.data };
  };
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

  // ── Export (full keys for re-import) ──────────────────────────

  app.get("/auth/api-keys/export", (c) => {
    return c.json({ keys: pool.exportForReimport() });
  });

  // ── Import (bulk) ─────────────────────────────────────────────

  app.post("/auth/api-keys/import", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { c.status(400); return c.json({ error: "Malformed JSON request body" }); }
    const parsed = await parseBody(BulkImportSchema)(body);
    if (!parsed.ok) { c.status(400); return c.json({ error: "Invalid request", details: parsed.error.issues }); }
    const result = pool.importMany(parsed.data.keys);
    return c.json({ success: true, ...result });
  });

  // ── Add single ────────────────────────────────────────────────

  app.post("/auth/api-keys", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { c.status(400); return c.json({ error: "Malformed JSON request body" }); }
    const parsed = await parseBody(AddKeySchema)(body);
    if (!parsed.ok) { c.status(400); return c.json({ error: "Invalid request", details: parsed.error.issues }); }
    const entry = pool.add(parsed.data as {
      provider: ApiKeyProvider;
      model: string;
      apiKey: string;
      baseUrl?: string;
      label?: string | null;
    });
    return c.json({ success: true, key: { ...entry, apiKey: maskKey(entry.apiKey) } });
  });

  // ── Batch delete ──────────────────────────────────────────────

  app.post("/auth/api-keys/batch-delete", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { c.status(400); return c.json({ error: "Malformed JSON request body" }); }
    const parsed = await parseBody(BatchDeleteSchema)(body);
    if (!parsed.ok) { c.status(400); return c.json({ error: "Invalid request", details: parsed.error.issues }); }
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
    let body: unknown;
    try { body = await c.req.json(); } catch { c.status(400); return c.json({ error: "Malformed JSON request body" }); }
    const parsed = await parseBody(LabelSchema)(body);
    if (!parsed.ok) { c.status(400); return c.json({ error: "Invalid request", details: parsed.error.issues }); }
    if (!pool.setLabel(c.req.param("id"), parsed.data.label)) { c.status(404); return c.json({ error: "API key not found" }); }
    return c.json({ success: true });
  });

  app.patch("/auth/api-keys/:id/status", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { c.status(400); return c.json({ error: "Malformed JSON request body" }); }
    const parsed = await parseBody(StatusSchema)(body);
    if (!parsed.ok) { c.status(400); return c.json({ error: "Invalid request", details: parsed.error.issues }); }
    if (!pool.setStatus(c.req.param("id"), parsed.data.status)) { c.status(404); return c.json({ error: "API key not found" }); }
    return c.json({ success: true });
  });

  return app;
}

function maskKey(key: string): string {
  if (key.length <= 8) return "****";
  return key.slice(0, 4) + "****" + key.slice(-4);
}
