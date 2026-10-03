/**
 * API key management routes.
 * CRUD + import/export + catalog for third-party provider API keys.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import {
  API_KEY_CAPABILITIES,
  API_KEY_WIRES,
} from "../auth/api-key-pool.js";
import type { ApiKeyEntry, ApiKeyPool } from "../auth/api-key-pool.js";
import { ApiKeyModelCache, ProviderModelFetchError } from "../auth/api-key-model-cache.js";
import { ApiKeyMemoStore, memoSignature } from "../auth/api-key-memo-store.js";
import type { ApiKeyMemo } from "../auth/api-key-memo-store.js";
import type { ApiKeyCapability } from "../auth/api-key-pool.js";

const VALID_PROVIDERS = ["anthropic", "openai", "gemini", "openrouter", "antigravity", "custom"] as const;
const MODEL_PROVIDERS = ["anthropic", "openai", "gemini", "openrouter", "custom"] as const;
const MEMO_PROVIDERS = MODEL_PROVIDERS;
const ModelsSchema = z.array(z.string().trim().min(1)).min(1).transform((models) => [...new Set(models)]);
const CapabilitiesSchema = z.array(z.enum(API_KEY_CAPABILITIES)).min(1).transform((capabilities) => [...new Set(capabilities)]).optional();
const WireSchema = z.enum(API_KEY_WIRES).optional();

const ApiKeyBindingObjectSchema = z.object({
  provider: z.enum(VALID_PROVIDERS),
  models: ModelsSchema,
  // Optional only when memoId resolves the key from a memo.
  apiKey: z.string().min(1).optional(),
  baseUrl: z.string().url().optional(),
  projectId: z.string().trim().min(1).max(256).optional(),
  label: z.string().max(64).nullable().optional(),
  capabilities: CapabilitiesSchema,
  wire: WireSchema,
  memoId: z.string().trim().min(1).optional(),
});

function refineBinding<T extends { provider: Provider; baseUrl?: string; wire?: z.infer<typeof WireSchema>; apiKey?: string; memoId?: string }>(schema: z.ZodType<T>): z.ZodEffects<z.ZodType<T>> {
  return schema.refine(
    (d) => Boolean(d.apiKey) || Boolean(d.memoId),
    { message: "apiKey is required unless a memoId is provided" },
  ).refine(
    (d) => d.provider !== "custom" || Boolean(d.baseUrl) || Boolean(d.memoId),
    { message: "baseUrl is required for custom providers" },
  ).refine(
    (d) => d.provider === "custom" || !d.baseUrl,
    { message: "baseUrl is only supported for custom providers" },
  ).refine(
    (d) => isProviderWireAllowed(d.provider, d.wire),
    { message: "wire is not supported for this provider" },
  ) as z.ZodEffects<z.ZodType<T>>;
}

const ApiKeyBindingSchema = refineBinding(ApiKeyBindingObjectSchema);

const FetchProviderModelsSchema = z.object({
  provider: z.enum(MODEL_PROVIDERS),
  apiKey: z.string().trim().min(1),
  baseUrl: z.string().trim().url().optional(),
  wire: WireSchema,
  force: z.boolean().optional(),
}).refine(
  (d) => d.provider !== "custom" || Boolean(d.baseUrl),
  { message: "baseUrl is required for custom providers" },
).refine(
  (d) => d.provider === "custom" || !d.baseUrl,
  { message: "baseUrl is only supported for custom providers" },
).refine(
  (d) => isProviderWireAllowed(d.provider, d.wire),
  { message: "wire is not supported for this provider" },
);

const BulkImportSchema = z.object({
  // Imports always carry explicit keys — memoId makes no sense in a file.
  keys: z.array(refineBinding(ApiKeyBindingObjectSchema.omit({ memoId: true })).refine(
    (d) => Boolean(d.apiKey),
    { message: "apiKey is required for imports" },
  )).min(1),
});

const CapabilitiesListSchema = z.array(z.enum(API_KEY_CAPABILITIES)).min(1).transform((capabilities) => [...new Set(capabilities)]);

const MemoCreateSchema = z.object({
  name: z.string().trim().max(64).optional(),
  provider: z.enum(MEMO_PROVIDERS),
  apiKey: z.string().trim().min(1),
  baseUrl: z.string().trim().url().optional(),
  wire: WireSchema,
  capabilities: CapabilitiesListSchema.optional(),
}).refine(
  (d) => d.provider !== "custom" || Boolean(d.baseUrl),
  { message: "baseUrl is required for custom providers" },
).refine(
  (d) => d.provider === "custom" || !d.baseUrl,
  { message: "baseUrl is only supported for custom providers" },
);

const MemoUpdateSchema = z.object({
  name: z.string().trim().max(64).optional(),
  apiKey: z.string().trim().min(1).optional(),
});

const MemoGenerateSchema = z.object({
  overwrite: z.boolean().optional(),
});

type MemoRouteInput = z.infer<typeof MemoCreateSchema>;
type PublicApiKeyMemo = Omit<ApiKeyMemo, "apiKey">;

type ApiKeyBindingInput = z.infer<typeof ApiKeyBindingSchema>;

type Provider = typeof VALID_PROVIDERS[number];

function isProviderWireAllowed(provider: Provider, wire: z.infer<typeof WireSchema>): boolean {
  if (!wire) return true;
  if (provider === "antigravity") return wire === "gemini";
  if (provider === "custom") return true;
  if (provider === "openai" || provider === "openrouter") return wire === "chat" || wire === "responses";
  return wire === provider;
}

function normalizeMemoCapabilities(capabilities: ApiKeyCapability[] | undefined): ApiKeyCapability[] {
  const deduped = [...new Set(capabilities ?? [])];
  return deduped.length > 0 ? deduped : ["chat"];
}

function toPublicMemo(memo: ApiKeyMemo): PublicApiKeyMemo {
  const { apiKey: _apiKey, ...publicMemo } = memo;
  return publicMemo;
}

function toMemoRouteInput(memo: ApiKeyMemo): MemoRouteInput {
  return {
    name: memo.name,
    provider: memo.provider,
    apiKey: memo.apiKey,
    baseUrl: memo.provider === "custom" ? memo.baseUrl : undefined,
    wire: memo.wire,
    capabilities: normalizeMemoCapabilities(memo.capabilities),
  };
}

function addEntries(pool: ApiKeyPool, items: Array<Omit<ApiKeyBindingInput, "apiKey" | "memoId"> & { apiKey: string }>): {
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
          projectId: item.projectId,
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

export function createApiKeyRoutes(pool: ApiKeyPool, modelCache = new ApiKeyModelCache(), memoStore = new ApiKeyMemoStore()): Hono {
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
      const result = await modelCache.fetchModels(parsed.data);
      return c.json(result);
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
    // refineBinding cannot narrow apiKey to string in the type system; the
    // runtime refine above guarantees it, so assert here.
    const result = addEntries(pool, parsed.data.keys.map((item) => ({ ...item, apiKey: item.apiKey! })));
    return c.json({ success: true, added: result.added, failed: result.failed, errors: result.errors });
  });

  // ── Add single ────────────────────────────────────────────────

  app.post("/auth/api-keys", async (c) => {
    const parsed = await parseJsonRequest(c, ApiKeyBindingSchema);
    if (!parsed.ok) return parsed.response;

    // Resolve memo defaults first; explicit fields in the request body win.
    let binding = parsed.data;
    if (binding.memoId) {
      const memo = memoStore.get(binding.memoId);
      if (!memo) {
        c.status(404);
        return c.json({ error: "Memo not found" });
      }
      const defaults = toMemoRouteInput(memo);
      binding = {
        ...defaults,
        ...binding,
        apiKey: binding.apiKey ?? defaults.apiKey,
        capabilities: binding.capabilities ?? defaults.capabilities,
        wire: binding.wire ?? defaults.wire,
        baseUrl: binding.baseUrl ?? defaults.baseUrl,
        label: binding.label ?? defaults.name ?? null,
        memoId: undefined,
      };
    }
    if (!binding.apiKey) {
      c.status(400);
      return c.json({ error: "apiKey is required" });
    }

    // Skip (model, key) pairs that already exist in the pool — re-submitting a
    // memo selection must not create duplicate entries; a different key for the
    // same model is still allowed (that is how LRU rotation is set up).
    const seen = new Set<string>();
    const existing = new Set(pool.getAll().map((entry) => `${entry.model}::${entry.apiKey}`));
    const requested = binding.models.filter((model) => {
      const pair = `${model}::${binding.apiKey}`;
      if (existing.has(pair) || seen.has(pair)) return false;
      seen.add(pair);
      return true;
    });
    if (requested.length === 0) {
      return c.json({ success: true, added: 0, failed: 0, keys: [], duplicates: binding.models.length });
    }

    const result = addEntries(pool, [{ ...binding, apiKey: binding.apiKey, models: requested }]);
    return c.json({
      success: true,
      added: result.added,
      failed: result.failed,
      duplicates: binding.models.length - requested.length,
      keys: result.keys.map((entry) => ({ ...entry, apiKey: maskKey(entry.apiKey) })),
    });
  });

  // ── Memos (add-key templates; never affect routing) ───────────

  app.get("/auth/api-keys/memos", (c) => {
    return c.json({ memos: memoStore.list().map(toPublicMemo) });
  });

  app.post("/auth/api-keys/memos", async (c) => {
    const parsed = await parseJsonRequest(c, MemoCreateSchema);
    if (!parsed.ok) return parsed.response;
    const input = parsed.data;
    const memo = memoStore.create({
      name: input.name,
      provider: input.provider,
      baseUrl: input.baseUrl ?? "",
      wire: input.wire ?? "chat",
      apiKey: input.apiKey,
      capabilities: input.capabilities,
    });
    return c.json({ memo: toPublicMemo(memo), masked: maskKey(memo.apiKey) });
  });

  app.patch("/auth/api-keys/memos/:id", async (c) => {
    const parsed = await parseJsonRequest(c, MemoUpdateSchema);
    if (!parsed.ok) return parsed.response;
    const memo = memoStore.update(c.req.param("id"), parsed.data);
    if (!memo) { c.status(404); return c.json({ error: "Memo not found" }); }
    return c.json({ memo: toPublicMemo(memo) });
  });

  app.delete("/auth/api-keys/memos/:id", (c) => {
    if (!memoStore.remove(c.req.param("id"))) { c.status(404); return c.json({ error: "Memo not found" }); }
    return c.json({ success: true });
  });

  // Re-fetch the provider model list with the memo's stored key.
  app.post("/auth/api-keys/memos/:id/models", async (c) => {
    const memo = memoStore.get(c.req.param("id"));
    if (!memo) { c.status(404); return c.json({ error: "Memo not found" }); }
    const force = c.req.query("force") === "1";
    try {
      const result = await modelCache.fetchModels({
        provider: memo.provider,
        apiKey: memo.apiKey,
        baseUrl: memo.provider === "custom" ? memo.baseUrl : undefined,
        wire: memo.wire,
        force,
      });
      const updated = memoStore.setModels(memo.id, result.models, result.fetchedAt);
      return c.json({ models: result.models, fetchedAt: result.fetchedAt, fromCache: result.fromCache, stale: result.stale, memo: updated ? toPublicMemo(updated) : undefined });
    } catch (err) {
      if (err instanceof ProviderModelFetchError && err.kind === "unauthorized") {
        c.status(401);
        return c.json({ error: "Failed to fetch models: unauthorized" });
      }
      c.status(502);
      return c.json({ error: err instanceof ProviderModelFetchError ? err.message : "Failed to reach provider" });
    }
  });

  // Memo generator — visible only while some (provider, baseUrl, wire, key,
  // capabilities) signature from the pool is not covered by any memo.
  app.get("/auth/api-keys/memos/coverage", (c) => {
    const uncovered = pool.getAll().filter((entry) => entry.provider !== "antigravity" && !memoStore.isCovered({
      provider: entry.provider,
      baseUrl: entry.baseUrl,
      wire: entry.wire,
      apiKey: entry.apiKey,
      capabilities: entry.capabilities,
    }));
    return c.json({
      uncovered: uncovered.length,
      canGenerate: uncovered.length > 0,
    });
  });

  app.post("/auth/api-keys/memos/generate", async (c) => {
    const parsed = await parseJsonRequest(c, MemoGenerateSchema).catch(() => ({ ok: true as const, data: { overwrite: false } }));
    if (!parsed.ok) return parsed.response;
    const result = memoStore.generateFromEntries(pool.getAll().flatMap((entry) => {
      if (entry.provider === "antigravity") return [];
      return [{
        provider: entry.provider,
        baseUrl: entry.baseUrl,
        wire: entry.wire,
        apiKey: entry.apiKey,
        capabilities: entry.capabilities,
      }];
    }));
    return c.json({ success: true, created: result.created.length, skipped: result.skipped, memos: memoStore.list().map(toPublicMemo) });
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
