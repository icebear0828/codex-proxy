/**
 * Synchronize model pricing catalog from LiteLLM and OpenRouter.
 *
 * Fetches upstream prices, merges them with local base catalog (preserving
 * proxy-specific models), and writes out `config/model-pricing.json`
 * and `config/model-pricing.yaml`.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const CONFIG_DIR = resolve(REPO_ROOT, "config");
const JSON_OUT_FILE = resolve(CONFIG_DIR, "model-pricing.json");
const YAML_OUT_FILE = resolve(CONFIG_DIR, "model-pricing.yaml");

const LITELLM_URLS = [
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
  "https://cdn.jsdelivr.net/gh/BerriAI/litellm@main/model_prices_and_context_window.json",
];

const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";

const OFFICIAL_PREFIX_ALLOWLIST = [
  "openai/",
  "anthropic/",
  "google/",
  "deepseek/",
];

const THIRD_PARTY_PREFIX_BLOCKLIST = [
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

const OFFICIAL_MODEL_PATTERNS = [
  /^gpt-/,
  /^chatgpt-/,
  /^o[1-9](?:-|$)/,
  /^claude-/,
  /^gemini-/,
  /^deepseek-/,
];

export function isOfficialModel(modelKey) {
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

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function roundToPrecision(val, precision = 8) {
  const factor = Math.pow(10, precision);
  return Math.round(val * factor) / factor;
}

async function fetchWithFallback(urls, timeoutMs = 15000) {
  for (const url of urls) {
    try {
      console.log(`[sync-pricing] fetching ${url}...`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      clearTimeout(timer);
      if (res.ok) {
        return await res.json();
      }
      console.warn(`[sync-pricing] ${url} returned HTTP ${res.status}`);
    } catch (err) {
      console.warn(`[sync-pricing] failed ${url}: ${err.message}`);
    }
  }
  return null;
}

export function convertLiteLlm(raw) {
  if (!isRecord(raw)) return {};
  const result = {};

  for (const [modelKey, data] of Object.entries(raw)) {
    if (!isRecord(data) || modelKey === "sample_spec") continue;
    if (!isOfficialModel(modelKey)) continue;

    const inputCost = data.input_cost_per_token;
    const outputCost = data.output_cost_per_token;
    if (typeof inputCost !== "number" || !Number.isFinite(inputCost) || inputCost < 0) continue;
    if (typeof outputCost !== "number" || !Number.isFinite(outputCost) || outputCost < 0) continue;

    const cacheReadCost = typeof data.cache_read_input_token_cost === "number" && Number.isFinite(data.cache_read_input_token_cost)
      ? data.cache_read_input_token_cost
      : inputCost;

    const pricing = {
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

export function convertOpenRouter(raw) {
  if (!isRecord(raw) || !Array.isArray(raw.data)) return {};
  const result = {};

  for (const item of raw.data) {
    if (!isRecord(item) || typeof item.id !== "string" || !isRecord(item.pricing)) continue;
    if (!isOfficialModel(item.id)) continue;
    const promptStr = item.pricing.prompt;
    const completionStr = item.pricing.completion;

    const promptNum = typeof promptStr === "string" ? parseFloat(promptStr) : typeof promptStr === "number" ? promptStr : NaN;
    const completionNum = typeof completionStr === "string" ? parseFloat(completionStr) : typeof completionStr === "number" ? completionStr : NaN;

    if (!Number.isFinite(promptNum) || promptNum < 0 || !Number.isFinite(completionNum) || completionNum < 0) continue;

    const pricing = {
      input_usd_per_million: roundToPrecision(promptNum * 1_000_000),
      cached_input_usd_per_million: roundToPrecision(promptNum * 1_000_000),
      output_usd_per_million: roundToPrecision(completionNum * 1_000_000),
    };

    result[item.id] = pricing;
    if (item.id.includes("/")) {
      const parts = item.id.split("/");
      const baseModel = parts[parts.length - 1];
      if (baseModel && !result[baseModel]) {
        result[baseModel] = { ...pricing };
      }
    }
  }

  return result;
}

function loadLocalBase() {
  const models = {};
  if (existsSync(YAML_OUT_FILE)) {
    try {
      const parsed = yaml.load(readFileSync(YAML_OUT_FILE, "utf8"));
      if (isRecord(parsed) && isRecord(parsed.models)) {
        Object.assign(models, parsed.models);
      }
    } catch (e) {
      console.warn(`[sync-pricing] cannot load local yaml: ${e.message}`);
    }
  }
  if (existsSync(JSON_OUT_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(JSON_OUT_FILE, "utf8"));
      if (isRecord(parsed) && isRecord(parsed.models)) {
        Object.assign(models, parsed.models);
      }
    } catch (e) {
      console.warn(`[sync-pricing] cannot load local json: ${e.message}`);
    }
  }
  return models;
}

export async function runSync(options = {}) {
  const localBase = loadLocalBase();
  console.log(`[sync-pricing] loaded ${Object.keys(localBase).length} local base models`);

  // 1. Fetch LiteLLM
  const litellmRaw = await fetchWithFallback(options.litellmUrls || LITELLM_URLS);
  const litellmModels = litellmRaw ? convertLiteLlm(litellmRaw) : {};
  console.log(`[sync-pricing] parsed ${Object.keys(litellmModels).length} models from LiteLLM`);

  // 2. Fetch OpenRouter (optional enhancement)
  let openRouterModels = {};
  if (options.includeOpenRouter !== false) {
    try {
      const openRouterRaw = await fetchWithFallback([options.openRouterUrl || OPENROUTER_URL], 10000);
      if (openRouterRaw) {
        openRouterModels = convertOpenRouter(openRouterRaw);
        console.log(`[sync-pricing] parsed ${Object.keys(openRouterModels).length} models from OpenRouter`);
      }
    } catch (e) {
      console.warn(`[sync-pricing] skipping OpenRouter: ${e.message}`);
    }
  }

  // Merge: openRouterModels -> litellmModels -> localBase
  // (local base catalog takes precedence to preserve official curated prices)
  const merged = {
    ...openRouterModels,
    ...litellmModels,
    ...localBase,
  };

  // Sort model keys alphabetically for deterministic diffs
  const sortedModels = {};
  for (const key of Object.keys(merged).sort()) {
    sortedModels[key] = merged[key];
  }

  const modelCount = Object.keys(sortedModels).length;
  console.log(`[sync-pricing] total consolidated models: ${modelCount}`);

  if (modelCount === 0) {
    throw new Error("No models consolidated; aborting write to prevent blank pricing file");
  }

  if (options.dryRun) {
    console.log("[sync-pricing] dry-run complete, skipped writing files");
    return { models: sortedModels, count: modelCount };
  }

  // Write JSON
  const jsonContent = JSON.stringify({ models: sortedModels }, null, 2) + "\n";
  const jsonPath = options.jsonOutFile || JSON_OUT_FILE;
  writeFileSync(jsonPath, jsonContent, "utf8");
  console.log(`[sync-pricing] wrote JSON: ${jsonPath}`);

  // Write YAML only if explicitly requested; never overwrite base model-pricing.yaml by default
  if (options.yamlOutFile) {
    const yamlHeader = `# Official and upstream API pricing catalog.\n# Unit: USD per 1,000,000 tokens.\n# Automatically synchronized by GitHub Actions.\n\n`;
    writeFileSync(options.yamlOutFile, yamlHeader + yaml.dump({ models: sortedModels }), "utf8");
    console.log(`[sync-pricing] wrote YAML: ${options.yamlOutFile}`);
  }

  return { models: sortedModels, count: modelCount };
}

// Run directly from CLI
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const dryRun = process.argv.includes("--dry-run");
  runSync({ dryRun }).catch((err) => {
    console.error(`[sync-pricing] failed: ${err.message}`);
    process.exit(1);
  });
}
