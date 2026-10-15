import type { UpstreamAdapter } from "./upstream-adapter.js";
import type { ApiKeyEntry } from "../auth/api-key-pool.js";
import type { Dispatcher } from "undici";
import { getFetchDispatcher } from "./fetch-dispatcher.js";
import type { ProxyPool } from "./proxy-pool.js";
import { OpenAIUpstream } from "./openai-upstream.js";
import { ResponsesUpstream } from "./responses-upstream.js";
import { AnthropicUpstream } from "./anthropic-upstream.js";
import { GeminiUpstream } from "./gemini-upstream.js";
import { AntigravityUpstream } from "./antigravity-upstream.js";
import { CodexResponsesUpstream } from "./codex-responses-upstream.js";

/**
 * OpenAI-family providers default to Chat Completions; an entry may opt into the
 * native Responses API via `wire: "responses"`.
 */
function createOpenAIFamilyAdapter(
  tag: "openai" | "openrouter" | "custom",
  entry: ApiKeyEntry,
  dispatcher?: Dispatcher,
): UpstreamAdapter {
  return entry.wire === "responses"
    ? new ResponsesUpstream(tag, entry.apiKey, entry.baseUrl, dispatcher)
    : new OpenAIUpstream(tag, entry.apiKey, entry.baseUrl, dispatcher);
}

function createCustomAdapter(entry: ApiKeyEntry, dispatcher?: Dispatcher): UpstreamAdapter {
  switch (entry.wire) {
    case "codex-responses":
      return new CodexResponsesUpstream(entry.apiKey, entry.baseUrl, entry.id);
    case "responses":
      return new ResponsesUpstream("custom", entry.apiKey, entry.baseUrl, dispatcher);
    case "anthropic":
      return new AnthropicUpstream(entry.apiKey, entry.baseUrl, dispatcher);
    case "gemini":
      return new GeminiUpstream(entry.apiKey, entry.baseUrl, dispatcher);
    case "chat":
      return new OpenAIUpstream("custom", entry.apiKey, entry.baseUrl, dispatcher);
  }
}

export function createAdapterForEntry(entry: ApiKeyEntry, proxyPool?: ProxyPool): UpstreamAdapter {
  const proxyUrl = proxyPool
    ? proxyPool.resolveProxyUrlById(entry.proxyId)
    : (entry.proxyId === "direct" ? null : (entry.proxyId?.startsWith("http") ? entry.proxyId : undefined));
  const dispatcher = getFetchDispatcher(proxyUrl);

  switch (entry.provider) {
    case "anthropic":
      return new AnthropicUpstream(entry.apiKey, entry.baseUrl, dispatcher);
    case "gemini":
      return new GeminiUpstream(entry.apiKey, entry.baseUrl, dispatcher);
    case "antigravity":
      return new AntigravityUpstream(entry.apiKey, entry.projectId, entry.baseUrl, dispatcher);
    case "openai":
      return createOpenAIFamilyAdapter("openai", entry, dispatcher);
    case "openrouter":
      return createOpenAIFamilyAdapter("openrouter", entry, dispatcher);
    case "custom":
      return createCustomAdapter(entry, dispatcher);
  }
}

