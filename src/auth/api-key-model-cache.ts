import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { getDataDir } from "../paths.js";
import { PROVIDER_CATALOG, isBuiltinProvider } from "./api-key-catalog.js";
import type { ApiKeyProvider, BuiltinProvider, CatalogModel, ProviderMeta } from "./api-key-catalog.js";

export const MODEL_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — provider model lists change frequently

export interface ApiKeyModelCacheEntry {
  url: string;
  models: CatalogModel[];
  fetchedAt: string;
}

export interface ApiKeyModelCacheFile {
  entries: Record<string, ApiKeyModelCacheEntry>;
}

export interface ApiKeyModelCachePersistence {
  load(): ApiKeyModelCacheFile;
  save(cache: ApiKeyModelCacheFile): void;
}

export interface FetchProviderModelsInput {
  provider: ApiKeyProvider;
  apiKey: string;
  baseUrl?: string;
}

interface ModelRequest {
  cacheUrl: string;
  requestUrl: string;
  headers: Record<string, string>;
}

export type ProviderModelFetchErrorKind = "unauthorized" | "provider" | "network" | "empty";

export class ProviderModelFetchError extends Error {
  constructor(public readonly kind: ProviderModelFetchErrorKind, message: string) {
    super(message);
    this.name = "ProviderModelFetchError";
  }
}

export interface ApiKeyModelCacheOptions {
  persistence?: ApiKeyModelCachePersistence;
  fetchFn?: typeof fetch;
  now?: () => Date;
}

const BUILTIN_MODEL_URLS: Record<BuiltinProvider, string> = {
  anthropic: "https://api.anthropic.com/v1/models",
  openai: "https://api.openai.com/v1/models",
  gemini: "https://generativelanguage.googleapis.com/v1beta/models",
  openrouter: "https://openrouter.ai/api/v1/models",
};

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

export function createFsApiKeyModelCachePersistence(filePath = resolve(getDataDir(), "api-key-models-cache.json")): ApiKeyModelCachePersistence {
  return {
    load: () => {
      if (!existsSync(filePath)) return { entries: {} };
      try {
        return parseCacheFile(JSON.parse(readFileSync(filePath, "utf-8")));
      } catch {
        return { entries: {} };
      }
    },
    save: (cache) => {
      mkdirSync(dirname(filePath), { recursive: true });
      const tmpFile = `${filePath}.tmp`;
      writeFileSync(tmpFile, JSON.stringify(cache, null, 2), "utf-8");
      renameSync(tmpFile, filePath);
    },
  };
}

export class ApiKeyModelCache {
  private readonly persistence: ApiKeyModelCachePersistence;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;

  constructor(options: ApiKeyModelCacheOptions = {}) {
    this.persistence = options.persistence ?? createFsApiKeyModelCachePersistence();
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  getCatalogWithCachedModels(): Record<BuiltinProvider, ProviderMeta> {
    // Load persistence once to avoid N disk reads for N providers.
    const cache = this.persistence.load();
    const catalog = {} as Record<BuiltinProvider, ProviderMeta>;
    for (const provider of Object.keys(PROVIDER_CATALOG) as BuiltinProvider[]) {
      const meta = PROVIDER_CATALOG[provider];
      catalog[provider] = {
        ...meta,
        models: this.getCachedModelsByUrlFromCache(cache, BUILTIN_MODEL_URLS[provider]) ?? meta.models,
      };
    }
    return catalog;
  }

  getCachedModelsByUrl(url: string): CatalogModel[] | null {
    return this.getCachedModelsByUrlFromCache(this.persistence.load(), url);
  }

  private getCachedModelsByUrlFromCache(cache: ApiKeyModelCacheFile, url: string): CatalogModel[] | null {
    const entry = cache.entries[url];
    if (!entry) return null;
    const fetchedAt = Date.parse(entry.fetchedAt);
    if (!Number.isFinite(fetchedAt)) return null;
    if (this.now().getTime() - fetchedAt >= MODEL_CACHE_TTL_MS) return null;
    return entry.models;
  }

  async fetchModels(input: FetchProviderModelsInput): Promise<CatalogModel[]> {
    const request = buildModelRequest(input);
    // Load once — reuse for both cache-hit check and write-back to avoid
    // two separate disk reads per request.
    const cache = this.persistence.load();
    const cached = this.getCachedModelsByUrlFromCache(cache, request.cacheUrl);
    if (cached) return cached;

    let response: Response;
    try {
      response = await this.fetchFn(request.requestUrl, {
        headers: request.headers,
      });
    } catch (err) {
      throw new ProviderModelFetchError("network", `Failed to reach provider: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (response.status === 401 || response.status === 403) {
      throw new ProviderModelFetchError("unauthorized", "Failed to fetch models: unauthorized");
    }
    if (!response.ok) {
      throw new ProviderModelFetchError("provider", "Failed to fetch models from provider");
    }

    const payload = await response.json().catch(() => null) as unknown;
    const models = normalizeProviderModels(input.provider, payload);
    if (models.length === 0) {
      throw new ProviderModelFetchError("empty", "Provider returned no models");
    }

    cache.entries[request.cacheUrl] = {
      url: request.cacheUrl,
      models,
      fetchedAt: this.now().toISOString(),
    };
    this.persistence.save(cache);
    return models;
  }
}

function parseCacheFile(value: unknown): ApiKeyModelCacheFile {
  if (!isRecord(value) || !isRecord(value.entries)) return { entries: {} };
  const entries: Record<string, ApiKeyModelCacheEntry> = {};
  for (const [key, rawEntry] of Object.entries(value.entries)) {
    if (!isRecord(rawEntry)) continue;
    const url = readString(rawEntry, "url");
    const fetchedAt = readString(rawEntry, "fetchedAt");
    if (!url || !fetchedAt || !Array.isArray(rawEntry.models)) continue;
    const models = normalizeCatalogModels(rawEntry.models);
    if (models.length === 0) continue;
    entries[key] = { url, fetchedAt, models };
  }
  return { entries };
}

function buildModelRequest(input: FetchProviderModelsInput): ModelRequest {
  const apiKey = input.apiKey.trim();
  if (input.provider === "custom") {
    const baseUrl = input.baseUrl?.trim();
    if (!baseUrl) throw new ProviderModelFetchError("provider", "baseUrl is required for custom providers");
    const cacheUrl = `${normalizeBaseUrl(baseUrl)}/models`;
    return {
      cacheUrl,
      requestUrl: cacheUrl,
      headers: bearerHeaders(apiKey),
    };
  }

  if (!isBuiltinProvider(input.provider)) {
    throw new ProviderModelFetchError("provider", "Unsupported provider");
  }

  const cacheUrl = BUILTIN_MODEL_URLS[input.provider];
  if (input.provider === "anthropic") {
    return {
      cacheUrl,
      requestUrl: cacheUrl,
      headers: {
        ...bearerHeaders(apiKey),
        "anthropic-version": "2023-06-01",
      },
    };
  }
  if (input.provider === "gemini") {
    const requestUrl = new URL(cacheUrl);
    requestUrl.searchParams.set("key", apiKey);
    return {
      cacheUrl,
      requestUrl: requestUrl.toString(),
      headers: { Accept: "application/json" },
    };
  }

  return {
    cacheUrl,
    requestUrl: cacheUrl,
    headers: bearerHeaders(apiKey),
  };
}

function bearerHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };
}

export function normalizeProviderModels(provider: ApiKeyProvider, payload: unknown): CatalogModel[] {
  if (provider === "gemini") return normalizeGeminiModels(payload);
  // Anthropic's /v1/models response uses `id` + `display_name` (no `name` field).
  // OpenAI and OpenRouter use `id` + `name` as the human-readable display.
  return normalizeDataModels(payload, provider === "anthropic" ? ["display_name", "name"] : ["name", "display_name"]);
}

function normalizeDataModels(payload: unknown, displayKeys: string[]): CatalogModel[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return [];
  const models: CatalogModel[] = [];
  for (const item of payload.data) {
    if (!isRecord(item)) continue;
    const id = readString(item, "id");
    if (!id) continue;
    models.push({
      id,
      displayName: readFirstString(item, displayKeys) || id,
    });
  }
  return dedupeCatalogModels(models);
}

function normalizeGeminiModels(payload: unknown): CatalogModel[] {
  if (!isRecord(payload) || !Array.isArray(payload.models)) return [];
  const models: CatalogModel[] = [];
  for (const item of payload.models) {
    if (!isRecord(item)) continue;
    const rawId = readString(item, "name");
    if (!rawId) continue;
    const id = rawId.startsWith("models/") ? rawId.slice("models/".length) : rawId;
    models.push({
      id,
      displayName: readFirstString(item, ["displayName", "display_name"]) || id,
    });
  }
  return dedupeCatalogModels(models);
}

function normalizeCatalogModels(items: unknown[]): CatalogModel[] {
  const models: CatalogModel[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const id = readString(item, "id");
    const displayName = readString(item, "displayName");
    if (!id || !displayName) continue;
    models.push({ id, displayName });
  }
  return dedupeCatalogModels(models);
}

function dedupeCatalogModels(models: CatalogModel[]): CatalogModel[] {
  const deduped = new Map<string, CatalogModel>();
  for (const model of models) deduped.set(model.id, model);
  return [...deduped.values()];
}

function readFirstString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = readString(record, key);
    if (value) return value;
  }
  return "";
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
