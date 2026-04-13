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
import { getModelAliases, getModelInfo } from "../models/model-store.js";

/** Factory that creates an UpstreamAdapter for a given ApiKeyEntry. */
export type AdapterFactory = (entry: ApiKeyEntry) => UpstreamAdapter;

export type UpstreamRouteMatch =
  | { kind: "api-key"; adapter: UpstreamAdapter; entry: ApiKeyEntry }
  | { kind: "adapter"; adapter: UpstreamAdapter }
  | { kind: "codex"; adapter?: UpstreamAdapter }
  | { kind: "not-found" };

export class UpstreamRouter {
  private apiKeyPool: ApiKeyPool | null = null;
  private adapterFactory: AdapterFactory | null = null;
  /** Cache: apiKeyEntry.id → adapter instance. Invalidated when key changes. */
  private dynamicAdapters = new Map<string, { apiKey: string; adapter: UpstreamAdapter }>();

  private splitExplicitProvider(model: string): { tag: string; bareModel: string } | null {
    const colonIdx = model.indexOf(":");
    if (colonIdx <= 0) return null;
    const tag = model.slice(0, colonIdx);
    if (!this.adapters.has(tag)) return null;
    return { tag, bareModel: model.slice(colonIdx + 1) };
  }

  private resolvePoolModelCandidates(model: string): string[] {
    const explicitProvider = this.splitExplicitProvider(model);
    return explicitProvider ? [model, explicitProvider.bareModel] : [model];
  }

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

  resolveMatch(model: string): UpstreamRouteMatch {
    const explicitProvider = this.splitExplicitProvider(model);

    if (this.apiKeyPool && this.adapterFactory) {
      for (const candidate of this.resolvePoolModelCandidates(model)) {
        const entries = this.apiKeyPool.getByModel(candidate);
        if (entries.length > 0) {
          const entry = pickLeastRecentlyUsed(entries);
          this.apiKeyPool.markUsed(entry.id);
          return { kind: "api-key", adapter: this.getOrCreateDynamicAdapter(entry), entry };
        }
      }
    }

    if (explicitProvider) {
      const adapter = this.adapters.get(explicitProvider.tag);
      if (adapter) return { kind: "adapter", adapter };
    }

    const routedTag = this.modelRouting[model];
    if (routedTag) {
      const adapter = this.adapters.get(routedTag);
      if (adapter) return { kind: routedTag === this.defaultTag ? "codex" : "adapter", adapter };
    }

    if (/^claude/i.test(model) && this.adapters.has("anthropic")) {
      return { kind: "adapter", adapter: this.adapters.get("anthropic")! };
    }
    if (/^gemini/i.test(model) && this.adapters.has("gemini")) {
      return { kind: "adapter", adapter: this.adapters.get("gemini")! };
    }

    if (this.isKnownCodexModel(model)) {
      return { kind: "codex" };
    }

    return { kind: "not-found" };
  }

  resolve(model: string): UpstreamAdapter {
    const match = this.resolveMatch(model);
    if (match.kind === "not-found" || !match.adapter) {
      throw new Error(`No upstream adapter available for model \"${model}\"`);
    }
    return match.adapter;
  }

  isCodexModel(model: string): boolean {
    return this.resolveMatch(model).kind === "codex";
  }

  hasApiKeyModel(model: string): boolean {
    return this.resolveMatch(model).kind === "api-key";
  }

  private isKnownCodexModel(model: string): boolean {
    const aliases = getModelAliases();
    const trimmed = model.trim();
    if (aliases[trimmed]) return true;
    if (getModelInfo(trimmed)) return true;
    if (/^(gpt|o\d|codex)/i.test(trimmed)) return true;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx > 0 && !this.adapters.has(trimmed.slice(0, colonIdx))) {
      return getModelInfo(trimmed) !== undefined;
    }

    return false;
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
