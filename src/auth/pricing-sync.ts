/**
 * Automated pricing sync and multi-source remote catalog loader.
 *
 * Sourced from LiteLLM's public repository (and OpenRouter fallback),
 * supporting multi-source dynamic fallback across GitHub raw, jsDelivr CDN,
 * and public proxies.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { getDataDir } from "../paths.js";
import { withFetchDispatcher } from "../proxy/fetch-dispatcher.js";
import {
  createPricingCatalog,
  setDynamicPricingCatalog,
  type ModelPricing,
  type PricingCatalog,
} from "./usage-pricing.js";

/** Default public CDN and mirror URLs for fetching the converted pricing table. */
export const DEFAULT_PRICING_TABLE_URLS: readonly string[] = [
  "https://cdn.jsdelivr.net/gh/BerriAI/litellm@main/model_prices_and_context_window.json",
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
];

export const pricingTableURLs = DEFAULT_PRICING_TABLE_URLS;

const CACHE_FILE_NAME = "model-pricing-cache.json";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

const OFFICIAL_PREFIX_ALLOWLIST: readonly string[] = [
  "openai/",
  "anthropic/",
  "google/",
  "deepseek/",
];

const THIRD_PARTY_PREFIX_BLOCKLIST: readonly string[] = [
  "azure/",
  "azure_ai/",
  "bedrock/",
  "bedrock_mantle/",
  "openrouter/",
  "together_ai/",
  "groq/",
  "fireworks_ai/",
  "deepinfra/",
  "perplexity/",
  "cloudflare/",
  "vertex_ai/",
  "sagemaker/",
  "anyscale/",
  "replicate/",
  "databricks/",
  "kyma/",
  "gmi/",
  "zerogpu/",
  "github_copilot/",
];

const OFFICIAL_MODEL_PATTERNS: readonly RegExp[] = [
  /^gpt-/,
  /^chatgpt-/,
  /^o[1-9](?:-|$)/,
  /^claude-/,
  /^gemini-/,
  /^deepseek-/,
];

/**
 * Filter ensuring only official vendor models (OpenAI, Anthropic, Google, DeepSeek)
 * are collected, dropping cloud wrappers (Azure, Bedrock) and community long-tail models.
 */
export function isOfficialModel(modelKey: string): boolean {
  if (!modelKey || typeof modelKey !== "string") return false;
  const lower = modelKey.toLowerCase().trim();

  for (const blocked of THIRD_PARTY_PREFIX_BLOCKLIST) {
    if (lower.startsWith(blocked)) return false;
  }

  for (const allowed of OFFICIAL_PREFIX_ALLOWLIST) {
    if (lower.startsWith(allowed)) {
      const remainder = lower.slice(allowed.length);
      return !remainder.includes("/") && remainder.length > 0;
    }
  }

  if (lower.includes("/")) {
    return false;
  }

  return OFFICIAL_MODEL_PATTERNS.some((pattern) => pattern.test(lower));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function roundToPrecision(val: number, precision = 8): number {
  const factor = Math.pow(10, precision);
  return Math.round(val * factor) / factor;
}

/**
 * Convert LiteLLM model_prices_and_context_window.json entry into project ModelPricing.
 */
export function convertLiteLlmPricing(raw: unknown): Record<string, ModelPricing> {
  if (!isRecord(raw)) return {};
  const result: Record<string, ModelPricing> = {};

  for (const [modelKey, data] of Object.entries(raw)) {
    if (!isRecord(data)) continue;
    // Skip template / documentation objects
    if (modelKey === "sample_spec") continue;
    if (!isOfficialModel(modelKey)) continue;

    const inputCost = data.input_cost_per_token;
    const outputCost = data.output_cost_per_token;
    if (typeof inputCost !== "number" || !Number.isFinite(inputCost) || inputCost < 0) continue;
    if (typeof outputCost !== "number" || !Number.isFinite(outputCost) || outputCost < 0) continue;

    const cacheReadCost = typeof data.cache_read_input_token_cost === "number" && Number.isFinite(data.cache_read_input_token_cost)
      ? data.cache_read_input_token_cost
      : inputCost;

    const pricing: ModelPricing = {
      input_usd_per_million: roundToPrecision(inputCost * 1_000_000),
      cached_input_usd_per_million: roundToPrecision(cacheReadCost * 1_000_000),
      output_usd_per_million: roundToPrecision(outputCost * 1_000_000),
    };

    if (typeof data.input_cost_per_image_token === "number" && Number.isFinite(data.input_cost_per_image_token)) {
      pricing.image_input_usd_per_million = roundToPrecision(data.input_cost_per_image_token * 1_000_000);
    }
    if (typeof data.output_cost_per_image_token === "number" && Number.isFinite(data.output_cost_per_image_token)) {
      pricing.image_output_usd_per_million = roundToPrecision(data.output_cost_per_image_token * 1_000_000);
    }

    result[modelKey] = pricing;

    // If model has a provider prefix (e.g. openai/gpt-4o), also register base model if not yet registered
    if (modelKey.includes("/")) {
      const parts = modelKey.split("/");
      const baseModel = parts[parts.length - 1];
      if (baseModel && isOfficialModel(baseModel) && !result[baseModel]) {
        result[baseModel] = { ...pricing };
      }
    }
  }

  return result;
}

/**
 * Convert OpenRouter GET /api/v1/models response into project ModelPricing.
 */
export function convertOpenRouterPricing(raw: unknown): Record<string, ModelPricing> {
  if (!isRecord(raw) || !Array.isArray(raw.data)) return {};
  const result: Record<string, ModelPricing> = {};

  for (const item of raw.data) {
    if (!isRecord(item) || typeof item.id !== "string" || !isRecord(item.pricing)) continue;
    if (!isOfficialModel(item.id)) continue;

    const promptStr = item.pricing.prompt;
    const completionStr = item.pricing.completion;

    const promptNum = typeof promptStr === "string" ? parseFloat(promptStr) : typeof promptStr === "number" ? promptStr : NaN;
    const completionNum = typeof completionStr === "string" ? parseFloat(completionStr) : typeof completionStr === "number" ? completionStr : NaN;

    if (!Number.isFinite(promptNum) || promptNum < 0 || !Number.isFinite(completionNum) || completionNum < 0) continue;

    const pricing: ModelPricing = {
      input_usd_per_million: roundToPrecision(promptNum * 1_000_000),
      cached_input_usd_per_million: roundToPrecision(promptNum * 1_000_000),
      output_usd_per_million: roundToPrecision(completionNum * 1_000_000),
    };

    result[item.id] = pricing;
    if (item.id.includes("/")) {
      const parts = item.id.split("/");
      const baseModel = parts[parts.length - 1];
      if (baseModel && isOfficialModel(baseModel) && !result[baseModel]) {
        result[baseModel] = { ...pricing };
      }
    }
  }

  return result;
}

/**
 * Merge multiple pricing catalogs into one, with later catalogs taking precedence for
 * common keys while retaining distinct keys from earlier catalogs.
 */
export function mergePricingCatalogs(...catalogs: Record<string, ModelPricing>[]): Record<string, ModelPricing> {
  const merged: Record<string, ModelPricing> = {};
  for (const catalog of catalogs) {
    for (const [key, value] of Object.entries(catalog)) {
      merged[key] = { ...value };
    }
  }
  return merged;
}

function parseRemotePayload(payload: unknown): Record<string, ModelPricing> | null {
  if (!isRecord(payload)) return null;

  // Format 1: Project's native JSON format `{ models: { ... } }`
  if (isRecord(payload.models)) {
    const entries: Record<string, ModelPricing> = {};
    for (const [model, value] of Object.entries(payload.models)) {
      if (
        isRecord(value) &&
        typeof value.input_usd_per_million === "number" &&
        typeof value.cached_input_usd_per_million === "number" &&
        typeof value.output_usd_per_million === "number"
      ) {
        entries[model] = {
          input_usd_per_million: value.input_usd_per_million,
          cached_input_usd_per_million: value.cached_input_usd_per_million,
          output_usd_per_million: value.output_usd_per_million,
          ...(typeof value.image_input_usd_per_million === "number"
            ? { image_input_usd_per_million: value.image_input_usd_per_million }
            : {}),
          ...(typeof value.image_output_usd_per_million === "number"
            ? { image_output_usd_per_million: value.image_output_usd_per_million }
            : {}),
        };
      }
    }
    return Object.keys(entries).length > 0 ? entries : null;
  }

  // Format 2: LiteLLM raw format `{ [model]: { input_cost_per_token, ... } }`
  const litellmParsed = convertLiteLlmPricing(payload);
  if (Object.keys(litellmParsed).length > 0) {
    return litellmParsed;
  }

  // Format 3: OpenRouter raw format `{ data: [ ... ] }`
  const openRouterParsed = convertOpenRouterPricing(payload);
  if (Object.keys(openRouterParsed).length > 0) {
    return openRouterParsed;
  }

  return null;
}

/**
 * Fetch pricing catalog by querying URLs in sequence until one succeeds.
 * Automatically saves disk cache and registers in-memory dynamic catalog.
 */
export async function fetchRemotePricingCatalog(options: {
  urls?: readonly string[];
  dataDir?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
} = {}): Promise<PricingCatalog | null> {
  const urls = options.urls ?? pricingTableURLs;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const dataDir = options.dataDir ?? getDataDir();

  for (const url of urls) {
    if (options.signal?.aborted) return null;
    try {
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      if (options.signal) {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let res: Response;
      try {
        res = await fetch(url, withFetchDispatcher({
          signal: controller.signal,
          headers: { Accept: "application/json" },
        }));
      } finally {
        clearTimeout(timer);
        if (options.signal) {
          options.signal.removeEventListener("abort", onAbort);
        }
      }

      if (options.signal?.aborted) return null;

      if (!res.ok) {
        console.warn(`[pricing] ${url} returned HTTP ${res.status}, trying next mirror...`);
        continue;
      }

      const json: unknown = await res.json();
      if (options.signal?.aborted) return null;

      const parsedEntries = parseRemotePayload(json);
      if (!parsedEntries || Object.keys(parsedEntries).length === 0) {
        console.warn(`[pricing] ${url} returned invalid or empty pricing catalog, trying next mirror...`);
        continue;
      }

      const catalog = createPricingCatalog(parsedEntries);
      setDynamicPricingCatalog(catalog);

      // Persist disk cache if dataDir is accessible and not aborted
      if (!options.signal?.aborted) {
        try {
          mkdirSync(dataDir, { recursive: true });
          writeFileSync(
            resolve(dataDir, CACHE_FILE_NAME),
            JSON.stringify({ models: parsedEntries, fetched_at: new Date().toISOString() }, null, 2),
            "utf8",
          );
        } catch (err) {
          console.warn(`[pricing] failed to save disk cache: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      console.info(`[pricing] successfully loaded dynamic pricing table (${Object.keys(catalog).length} models) from ${url}`);
      return catalog;
    } catch (err) {
      if (options.signal?.aborted) return null;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[pricing] failed to fetch from ${url}: ${msg}, trying next mirror...`);
    }
  }

  console.warn("[pricing] all pricing table mirror URLs failed; falling back to local catalog");
  return null;
}

/**
 * Try loading pricing catalog from disk cache (`data/model-pricing-cache.json`).
 */
export function loadCachedPricingCatalog(dataDir = getDataDir()): PricingCatalog | null {
  try {
    const cachePath = resolve(dataDir, CACHE_FILE_NAME);
    if (!existsSync(cachePath)) return null;
    const content = readFileSync(cachePath, "utf8");
    const parsed: unknown = JSON.parse(content);
    const entries = parseRemotePayload(parsed);
    if (!entries) return null;
    return createPricingCatalog(entries);
  } catch {
    return null;
  }
}

/**
 * Start periodic background sync scheduler for pricing tables.
 * Returns an unregister/stop function that also aborts any in-flight fetch.
 */
export function startPricingSyncScheduler(options: {
  intervalMs?: number;
  urls?: readonly string[];
  dataDir?: string;
} = {}): () => void {
  const intervalMs = options.intervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let activeController: AbortController | null = null;
  let stopped = false;

  const scheduleNext = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      if (stopped) return;
      activeController = new AbortController();
      try {
        await fetchRemotePricingCatalog({ ...options, signal: activeController.signal });
      } catch (err) {
        console.warn(`[pricing] background sync cycle failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        activeController = null;
      }
      if (!stopped) scheduleNext();
    }, intervalMs);
    if (timer.unref) timer.unref();
  };

  scheduleNext();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (activeController) activeController.abort();
  };
}
