/**
 * Official API price catalog and local usage-cost estimation.
 *
 * Prices are USD per one million tokens. This is an estimate based on the
 * public API price list, not an upstream ChatGPT billing balance.
 */

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import yaml from "js-yaml";
import { getConfigDir, getDataDir } from "../paths.js";

export interface ModelPricing {
  input_usd_per_million: number;
  cached_input_usd_per_million: number;
  output_usd_per_million: number;
  image_input_usd_per_million?: number;
  image_output_usd_per_million?: number;
}

export type PricingCatalog = Readonly<Record<string, ModelPricing>>;

const PRICE_FILE_YAML = "model-pricing.yaml";
const PRICE_FILE_JSON = "model-pricing.json";
const PRICE_FILE = PRICE_FILE_YAML;
const MODEL_SUFFIX_PATTERN = /-(?:fast|flex|max|ultra|none|minimal|low|medium|high|xhigh)$/;

let dynamicPricingCatalog: PricingCatalog | null = null;

export function setDynamicPricingCatalog(catalog: PricingCatalog | null): void {
  dynamicPricingCatalog = catalog;
}

export function getDynamicPricingCatalog(): PricingCatalog | null {
  return dynamicPricingCatalog;
}

export function resetDynamicPricingCatalog(): void {
  dynamicPricingCatalog = null;
}

export function createPricingCatalog(entries: Record<string, ModelPricing>): PricingCatalog {
  const catalog: Record<string, ModelPricing> = {};
  for (const [model, pricing] of Object.entries(entries)) {
    if (!model.trim()) throw new Error("pricing model name must not be empty");
    for (const [field, value] of Object.entries(pricing)) {
      if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
        throw new Error(`${model}.${field} must be finite and non-negative`);
      }
    }
    catalog[model] = { ...pricing };
  }
  return catalog;
}

function parsePricingMapping(parsed: unknown, sourceFile: string): PricingCatalog {
  if (!isRecord(parsed) || !isRecord(parsed.models)) {
    throw new Error(`${sourceFile} must contain a models mapping`);
  }
  const entries: Record<string, ModelPricing> = {};
  for (const [model, value] of Object.entries(parsed.models)) {
    if (!isRecord(value) ||
        !isNumber(value.input_usd_per_million) ||
        !isNumber(value.cached_input_usd_per_million) ||
        !isNumber(value.output_usd_per_million)) {
      throw new Error(`${sourceFile}: invalid pricing entry for ${model}`);
    }
    entries[model] = {
      input_usd_per_million: value.input_usd_per_million,
      cached_input_usd_per_million: value.cached_input_usd_per_million,
      output_usd_per_million: value.output_usd_per_million,
      ...(isNumber(value.image_input_usd_per_million) ? { image_input_usd_per_million: value.image_input_usd_per_million } : {}),
      ...(isNumber(value.image_output_usd_per_million) ? { image_output_usd_per_million: value.image_output_usd_per_million } : {}),
    };
  }
  return createPricingCatalog(entries);
}

export function loadPricingCatalog(configDir = getConfigDir(), dataDir = getDataDir()): PricingCatalog {
  // 1. Load local catalog from configDir (primary source of truth)
  let localCatalog: PricingCatalog | null = null;
  const yamlPath = resolve(configDir, PRICE_FILE_YAML);
  const jsonPath = resolve(configDir, PRICE_FILE_JSON);

  if (existsSync(yamlPath)) {
    const parsed: unknown = yaml.load(readFileSync(yamlPath, "utf8"));
    localCatalog = parsePricingMapping(parsed, PRICE_FILE_YAML);
  } else if (existsSync(jsonPath)) {
    const parsed: unknown = JSON.parse(readFileSync(jsonPath, "utf8"));
    localCatalog = parsePricingMapping(parsed, PRICE_FILE_JSON);
  } else if (configDir !== getConfigDir()) {
    throw new Error(`${PRICE_FILE_YAML} must contain a models mapping`);
  }

  // If a custom configDir is passed (e.g. isolated test fixtures), return local directly
  if (configDir !== getConfigDir()) {
    return localCatalog ?? createPricingCatalog({});
  }

  // 2. Resolve fallback dynamic/cached catalog
  let fallbackCatalog: PricingCatalog | null = dynamicPricingCatalog;
  if (!fallbackCatalog) {
    const cacheFile = resolve(dataDir, "model-pricing-cache.json");
    if (existsSync(cacheFile)) {
      try {
        const raw: unknown = JSON.parse(readFileSync(cacheFile, "utf8"));
        fallbackCatalog = parsePricingMapping(raw, cacheFile);
      } catch {
        // Fall back to local catalog on corrupt cache
      }
    }
  }

  // 3. Merge: fallback dynamic catalog fills missing models, but localCatalog ALWAYS overrides
  if (fallbackCatalog && Object.keys(fallbackCatalog).length > 0) {
    return createPricingCatalog({
      ...fallbackCatalog,
      ...(localCatalog ?? {}),
    });
  }

  if (localCatalog) {
    return localCatalog;
  }

  throw new Error(`${PRICE_FILE_YAML} must contain a models mapping`);
}

const PRICING_WARN_COOLDOWN_MS = 5 * 60_000;
const lastPricingWarnAt = new Map<string, number>();

/**
 * Report a pricing-catalog load failure with the resolved file path.
 *
 * Missing or invalid pricing used to degrade every estimated cost to zero with
 * no trace at all (#837); callers that swallow the load error must call this so
 * the condition is at least visible to the operator. Warnings are deduplicated
 * per (path, reason), so a caller that retries on every request stays quiet.
 */
export function warnPricingLoadFailure(error: unknown, configDir = getConfigDir()): void {
  const path = resolve(configDir, PRICE_FILE);
  const reason = error instanceof Error ? error.message : String(error);
  const signature = `${path}|${reason}`;
  const now = Date.now();
  const last = lastPricingWarnAt.get(signature);
  if (last !== undefined && now - last < PRICING_WARN_COOLDOWN_MS) return;
  lastPricingWarnAt.set(signature, now);
  console.warn(
    `[pricing] cannot load ${path}: ${reason} — usage is still recorded, but estimated costs stay unavailable until the file loads`,
  );
}

/** Test hook: clear the pricing-warning dedupe state. */
export function resetPricingLoadWarnings(): void {
  lastPricingWarnAt.clear();
}

export function resolveModelPricing(model: string, catalog: PricingCatalog): ModelPricing | null {
  const normalized = model.trim();
  if (!normalized) return null;
  const exact = catalog[normalized];
  if (exact) return exact;

  let base = normalized;
  while (MODEL_SUFFIX_PATTERN.test(base)) {
    base = base.replace(MODEL_SUFFIX_PATTERN, "");
    const match = catalog[base];
    if (match) return match;
  }
  return null;
}

export interface UsageCostInput {
  input_tokens: number;
  output_tokens: number;
  cached_tokens?: number;
  image_input_tokens?: number;
  image_output_tokens?: number;
}

const DEFAULT_IMAGE_MODEL = "gpt-image-2";

export function calculateUsageCostUsd(
  model: string,
  usage: UsageCostInput,
  catalog: PricingCatalog,
): number {
  const pricing = resolveModelPricing(model, catalog);
  if (!pricing) return 0;
  const input = nonNegative(usage.input_tokens);
  const cached = Math.min(input, nonNegative(usage.cached_tokens ?? 0));
  const output = nonNegative(usage.output_tokens);
  let cost = (
    (input - cached) * pricing.input_usd_per_million +
    cached * pricing.cached_input_usd_per_million +
    output * pricing.output_usd_per_million
  ) / 1_000_000;

  const imagePricing = pricing.image_input_usd_per_million !== undefined || pricing.image_output_usd_per_million !== undefined
    ? pricing
    : catalog[DEFAULT_IMAGE_MODEL];

  if (imagePricing?.image_input_usd_per_million !== undefined) {
    cost += nonNegative(usage.image_input_tokens ?? 0) * imagePricing.image_input_usd_per_million / 1_000_000;
  }
  if (imagePricing?.image_output_usd_per_million !== undefined) {
    cost += nonNegative(usage.image_output_tokens ?? 0) * imagePricing.image_output_usd_per_million / 1_000_000;
  }
  return cost;
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
