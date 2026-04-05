/**
 * UpstreamRouter — routes a model name to the appropriate UpstreamAdapter.
 *
 * Priority (highest to lowest):
 *   1. Explicit provider prefix: "openai:gpt-4o", "anthropic:claude-3-5-sonnet"
 *   2. model_routing config table: { "deepseek-chat": "deepseek" }
 *   3. Custom provider `models` list
 *   4. Built-in name pattern rules: "claude-*" → anthropic, "gemini-*" → gemini
 *   5. Default (codex)
 */

import type { UpstreamAdapter } from "./upstream-adapter.js";

export class UpstreamRouter {
  constructor(
    private readonly adapters: Map<string, UpstreamAdapter>,
    private readonly modelRouting: Record<string, string>,
    private readonly defaultTag: string,
  ) {}

  resolve(model: string): UpstreamAdapter {
    const defaultAdapter = this.adapters.get(this.defaultTag) ?? this.adapters.values().next().value!;

    // 1. Explicit provider prefix "provider:model-name"
    const colonIdx = model.indexOf(":");
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
}
