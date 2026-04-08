/**
 * UpstreamRouter — routes a model name to the appropriate UpstreamAdapter.
 *
 * Priority (highest to lowest):
 *   0. ApiKeyPool entry matching the exact model name
 *   1. Explicit provider prefix: "openai:gpt-4o", "anthropic:claude-3-5-sonnet"
 *   2. model_routing config table: { "deepseek-chat": "deepseek" }
 *   3. Custom provider `models` list
 *   4. Built-in name pattern rules: "claude-*" → anthropic, "gemini-*" → gemini
 *   5. Default (codex)
 */

import type { UpstreamAdapter } from "./upstream-adapter.js";
import type { ApiKeyPool, ApiKeyEntry } from "../auth/api-key-pool.js";

/** Factory that creates an UpstreamAdapter for a given ApiKeyEntry. */
export type AdapterFactory = (entry: ApiKeyEntry) => UpstreamAdapter;

export class UpstreamRouter {
  private apiKeyPool: ApiKeyPool | null = null;
  private adapterFactory: AdapterFactory | null = null;
  /** Cache: apiKeyEntry.id → adapter instance. Invalidated when key changes. */
  private dynamicAdapters = new Map<string, { apiKey: string; adapter: UpstreamAdapter }>();

  constructor(
    private readonly adapters: Map<string, UpstreamAdapter>,
    private readonly modelRouting: Record<string, string>,
    private readonly defaultTag: string,
  ) {}

  /** Attach the runtime API key pool for dynamic model resolution. */
  setApiKeyPool(pool: ApiKeyPool, factory: AdapterFactory): void {
    this.apiKeyPool = pool;
    this.adapterFactory = factory;
  }

  resolve(model: string): UpstreamAdapter {
    const defaultAdapter = this.adapters.get(this.defaultTag) ?? this.adapters.values().next().value!;

    // Strip provider prefix for pool lookup
    const colonIdx = model.indexOf(":");
    const bareModel = colonIdx > 0 ? model.slice(colonIdx + 1) : model;

    // 0. ApiKeyPool — exact model match (highest priority)
    if (this.apiKeyPool && this.adapterFactory) {
      const entries = this.apiKeyPool.getByModel(bareModel);
      if (entries.length > 0) {
        // Round-robin via least-recently-used
        const entry = pickLeastRecentlyUsed(entries);
        this.apiKeyPool.markUsed(entry.id);
        return this.getOrCreateDynamicAdapter(entry);
      }
    }

    // 1. Explicit provider prefix "provider:model-name"
    if (colonIdx > 0) {
      const tag = model.slice(0, colonIdx);
      const adapter = this.adapters.get(tag);
      if (adapter) return adapter;
    }

    // 2. Explicit config routing table
    const routedTag = this.modelRouting[model];
    if (routedTag) {
      const adapter = this.adapters.get(routedTag);
      if (adapter) return adapter;
    }

    // 3. Built-in name pattern matching (only if the corresponding adapter exists)
    if (/^claude/i.test(model) && this.adapters.has("anthropic")) {
      return this.adapters.get("anthropic")!;
    }
    if (/^gemini/i.test(model) && this.adapters.has("gemini")) {
      return this.adapters.get("gemini")!;
    }

    // 4. Default adapter
    return defaultAdapter;
  }

  isCodexModel(model: string): boolean {
    return this.resolve(model).tag === "codex";
  }

  private getOrCreateDynamicAdapter(entry: ApiKeyEntry): UpstreamAdapter {
    const cached = this.dynamicAdapters.get(entry.id);
    if (cached && cached.apiKey === entry.apiKey) return cached.adapter;
    const adapter = this.adapterFactory!(entry);
    this.dynamicAdapters.set(entry.id, { apiKey: entry.apiKey, adapter });
    return adapter;
  }
}

function pickLeastRecentlyUsed(entries: ApiKeyEntry[]): ApiKeyEntry {
  let best = entries[0];
  for (let i = 1; i < entries.length; i++) {
    const e = entries[i];
    if (!e.lastUsedAt) return e; // never used → pick immediately
    if (!best.lastUsedAt || e.lastUsedAt < best.lastUsedAt) best = e;
  }
  return best;
}
