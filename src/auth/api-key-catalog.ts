/**
 * Predefined model catalogs for the "big three" providers.
 * Custom providers are not listed here — users supply their own model IDs.
 */

export type BuiltinProvider = "anthropic" | "openai" | "gemini" | "openrouter";
export type ApiKeyProvider = BuiltinProvider | "custom";

export interface CatalogModel {
  id: string;
  displayName: string;
}

export interface ProviderMeta {
  displayName: string;
  defaultBaseUrl: string;
  models: CatalogModel[];
}

export const PROVIDER_CATALOG: Record<BuiltinProvider, ProviderMeta> = {
  anthropic: {
    displayName: "Anthropic",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    // Minimal fallback — overridden by dynamic fetch after API key entry.
    models: [
      { id: "claude-opus-4-5", displayName: "Claude Opus 4.5" },
      { id: "claude-sonnet-4-5", displayName: "Claude Sonnet 4.5" },
      { id: "claude-haiku-4-5", displayName: "Claude Haiku 4.5" },
    ],
  },
  openai: {
    displayName: "OpenAI",
    defaultBaseUrl: "https://api.openai.com/v1",
    models: [
      { id: "gpt-4.1", displayName: "GPT-4.1" },
      { id: "gpt-4.1-mini", displayName: "GPT-4.1 Mini" },
      { id: "o4-mini", displayName: "o4 Mini" },
    ],
  },
  gemini: {
    displayName: "Google Gemini",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    models: [
      { id: "gemini-2.5-pro", displayName: "Gemini 2.5 Pro" },
      { id: "gemini-2.5-flash", displayName: "Gemini 2.5 Flash" },
    ],
  },
  openrouter: {
    displayName: "OpenRouter",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    models: [
      { id: "anthropic/claude-sonnet-4-5", displayName: "Claude Sonnet 4.5" },
      { id: "openai/gpt-4.1", displayName: "GPT-4.1" },
      { id: "google/gemini-2.5-pro", displayName: "Gemini 2.5 Pro" },
      { id: "deepseek/deepseek-r1", displayName: "DeepSeek R1" },
    ],
  },
};

/** Check whether a provider name is one of the built-in providers. */
export function isBuiltinProvider(provider: string): provider is BuiltinProvider {
  return provider === "anthropic" || provider === "openai" || provider === "gemini" || provider === "openrouter";
}
