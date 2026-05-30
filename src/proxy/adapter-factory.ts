/**
 * Adapter factory — creates UpstreamAdapter instances from ApiKeyEntry.
 * Used by UpstreamRouter for dynamic API key pool entries.
 */

import type { UpstreamAdapter } from "./upstream-adapter.js";
import type { ApiKeyEntry } from "../auth/api-key-pool.js";
import { OpenAIUpstream } from "./openai-upstream.js";

export function createAdapterForEntry(entry: ApiKeyEntry): UpstreamAdapter {
  switch (entry.format) {
    case "openai":
      return new OpenAIUpstream(entry.provider, entry.apiKey, entry.baseUrl);
  }
}
