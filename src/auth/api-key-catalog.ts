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

const ANTHROPIC_MODELS: CatalogModel[] = [
  { id: "claude-opus-4-6", displayName: "Claude Opus 4.6" },
  { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-5", displayName: "Claude Haiku 4.5" },
];

const OPENAI_MODELS: CatalogModel[] = [
  { id: "gpt-5.4", displayName: "GPT-5.4" },
  { id: "gpt-5.4-mini", displayName: "GPT-5.4 Mini" },
  { id: "gpt-5.3-codex", displayName: "GPT-5.3 Codex" },
  { id: "gpt-4.1", displayName: "GPT-4.1" },
  { id: "gpt-4.1-mini", displayName: "GPT-4.1 Mini" },
  { id: "o3", displayName: "o3" },
  { id: "o3-mini", displayName: "o3 Mini" },
  { id: "o4-mini", displayName: "o4 Mini" },
];

const GEMINI_MODELS: CatalogModel[] = [
  { id: "gemini-3.1-pro-preview", displayName: "Gemini 3.1 Pro" },
  { id: "gemini-3-flash-preview", displayName: "Gemini 3 Flash" },
  { id: "gemini-2.5-flash", displayName: "Gemini 2.5 Flash" },
];

const OPENROUTER_MODELS: CatalogModel[] = [
  { id: "anthropic/claude-opus-4.6", displayName: "Claude Opus 4.6" },
  { id: "anthropic/claude-sonnet-4.6", displayName: "Claude Sonnet 4.6" },
  { id: "openai/gpt-5.4", displayName: "GPT-5.4" },
  { id: "google/gemini-3.1-pro-preview", displayName: "Gemini 3.1 Pro" },
  { id: "google/gemini-3.1-flash-lite", displayName: "Gemini 3.1 Flash Lite" },
  { id: "deepseek/deepseek-v3.2", displayName: "DeepSeek V3.2" },
  { id: "deepseek/deepseek-r1", displayName: "DeepSeek R1" },
  { id: "meta-llama/llama-4-maverick", displayName: "Llama 4 Maverick" },
  { id: "mistralai/mistral-small-4", displayName: "Mistral Small 4" },
  { id: "qwen/qwen3-coder-480b-a35b-07-25", displayName: "Qwen3 Coder 480B" },
];

export const PROVIDER_CATALOG: Record<BuiltinProvider, ProviderMeta> = {
  anthropic: {
    displayName: "Anthropic",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    models: ANTHROPIC_MODELS,
  },
  openai: {
    displayName: "OpenAI",
    defaultBaseUrl: "https://api.openai.com/v1",
    models: OPENAI_MODELS,
  },
  gemini: {
    displayName: "Google Gemini",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    models: GEMINI_MODELS,
  },
  openrouter: {
    displayName: "OpenRouter",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    models: OPENROUTER_MODELS,
  },
};

/** Check whether a provider name is one of the built-in providers. */
export function isBuiltinProvider(provider: string): provider is BuiltinProvider {
  return provider === "anthropic" || provider === "openai" || provider === "gemini" || provider === "openrouter";
}
