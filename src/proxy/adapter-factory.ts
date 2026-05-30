/**
 * Adapter factory — creates UpstreamAdapter instances from ApiKeyEntry.
 * Used by UpstreamRouter for dynamic API key pool entries.
 */

import type { UpstreamAdapter } from "./upstream-adapter.js";
import type { ApiKeyEntry } from "../auth/api-key-pool.js";
import { OpenAIUpstream } from "./openai-upstream.js";
import { ResponsesUpstream } from "./responses-upstream.js";
import { AnthropicUpstream } from "./anthropic-upstream.js";
import { GeminiUpstream } from "./gemini-upstream.js";

/**
 * OpenAI-family providers default to Chat Completions; an entry may opt into the
 * native Responses API via `wire: "responses"`. anthropic/gemini ignore `wire`.
 */
function createOpenAIFamilyAdapter(
  tag: "openai" | "openrouter" | "custom",
  entry: ApiKeyEntry,
): UpstreamAdapter {
  return entry.wire === "responses"
    ? new ResponsesUpstream(tag, entry.apiKey, entry.baseUrl)
    : new OpenAIUpstream(tag, entry.apiKey, entry.baseUrl);
}

export function createAdapterForEntry(entry: ApiKeyEntry): UpstreamAdapter {
  switch (entry.provider) {
    case "anthropic":
      return new AnthropicUpstream(entry.apiKey);
    case "gemini":
      return new GeminiUpstream(entry.apiKey);
    case "openai":
      return createOpenAIFamilyAdapter("openai", entry);
    case "openrouter":
      return createOpenAIFamilyAdapter("openrouter", entry);
    case "custom":
      return createOpenAIFamilyAdapter("custom", entry);
  }
}
