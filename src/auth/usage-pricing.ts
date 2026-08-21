/**
 * Official API price catalog and local usage-cost estimation.
 *
 * Prices are USD per one million tokens. This is an estimate based on the
 * public API price list, not an upstream ChatGPT billing balance.
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import yaml from "js-yaml";
import { getConfigDir } from "../paths.js";

export interface ModelPricing {
  input_usd_per_million: number;
  cached_input_usd_per_million: number;
  output_usd_per_million: number;
  image_input_usd_per_million?: number;
  image_output_usd_per_million?: number;
}

export type PricingCatalog = Readonly<Record<string, ModelPricing>>;

const PRICE_FILE = "model-pricing.yaml";
const MODEL_SUFFIX_PATTERN = /-(?:fast|flex|none|minimal|low|medium|high|xhigh)$/;

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

export function loadPricingCatalog(configDir = getConfigDir()): PricingCatalog {
  const parsed: unknown = yaml.load(readFileSync(resolve(configDir, PRICE_FILE), "utf8"));
  if (!isRecord(parsed) || !isRecord(parsed.models)) {
    throw new Error(`${PRICE_FILE} must contain a models mapping`);
  }
  const entries: Record<string, ModelPricing> = {};
  for (const [model, value] of Object.entries(parsed.models)) {
    if (!isRecord(value) ||
        !isNumber(value.input_usd_per_million) ||
        !isNumber(value.cached_input_usd_per_million) ||
        !isNumber(value.output_usd_per_million)) {
      throw new Error(`${PRICE_FILE}: invalid pricing entry for ${model}`);
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
