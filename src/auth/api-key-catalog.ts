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
    models: [],
  },
  openai: {
    displayName: "OpenAI",
    defaultBaseUrl: "https://api.openai.com/v1",
    models: [],
  },
  gemini: {
    displayName: "Google Gemini",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    models: [],
  },
  openrouter: {
    displayName: "OpenRouter",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    models: [],
  },
};

/** Check whether a provider name is one of the built-in providers. */
export function isBuiltinProvider(provider: string): provider is BuiltinProvider {
  return provider === "anthropic" || provider === "openai" || provider === "gemini" || provider === "openrouter";
}
