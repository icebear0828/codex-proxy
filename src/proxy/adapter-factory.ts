/**
 * Adapter factory — creates UpstreamAdapter instances from ApiKeyEntry.
 * Used by UpstreamRouter for dynamic API key pool entries.
 */

import type { UpstreamAdapter } from "./upstream-adapter.js";
import type { ApiKeyEntry } from "../auth/api-key-pool.js";
import { OpenAIUpstream } from "./openai-upstream.js";
import { AnthropicUpstream } from "./anthropic-upstream.js";
import { GeminiUpstream } from "./gemini-upstream.js";

export function createAdapterForEntry(entry: ApiKeyEntry): UpstreamAdapter {
  switch (entry.provider) {
    case "anthropic":
      return new AnthropicUpstream(entry.apiKey);
    case "gemini":
      return new GeminiUpstream(entry.apiKey);
    case "openai":
      return new OpenAIUpstream("openai", entry.apiKey, entry.baseUrl);
    case "openrouter":
      return new OpenAIUpstream("openrouter", entry.apiKey, entry.baseUrl);
    case "custom":
      return new OpenAIUpstream("custom", entry.apiKey, entry.baseUrl);
  }
}
