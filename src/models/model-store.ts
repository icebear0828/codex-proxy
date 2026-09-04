/**
 * Model Store — manages model catalog + aliases.
 *
 * Data flow:
 *   1. loadStatic() — load last successful backend snapshot from data/models-cache.yaml
 *   2. applyBackendModelsForPlan() — replace that plan's backend model snapshot
 *   3. getters — runtime reads from mutable state
 *
 * Aliases come only from local `model.aliases`; they are not exposed as models.
 *
 * The ModelStore class owns all state. Module-level free functions delegate
 * to a default instance for backward compatibility.
 */

import { readFileSync, writeFile, existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import yaml from "js-yaml";
import { getConfig } from "../config.js";
import type { AppConfig } from "../config-schema.js";
import { getConfigDir, getDataDir } from "../paths.js";

// ── Types ────────────────────────────────────────────────────────────

export interface CodexModelInfo {
  id: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
  defaultReasoningEffort: string;
  inputModalities: string[];
  /** Output content types. Defaults to ['text'] when absent (chat models). */
  outputModalities?: string[];
  supportsPersonality: boolean;
  upgrade: string | null;
  /** Maximum total context window in tokens, when known. */
  contextWindow?: number;
  /** Maximum expandable context window reported by the Codex backend, when known. */
  maxContextWindow?: number;
  /** Maximum configurable output token budget, when known. */
  maxOutputTokens?: number;
  /** Token threshold where clients should compact conversation history, when known. */
  autoCompactTokenLimit?: number;
  /** Backend truncation policy limit, when reported. */
  truncationPolicyLimit?: number;
  /** Where this model entry came from */
  source?: "static" | "backend" | "custom";
}

interface ModelsConfig {
  models: CodexModelInfo[];
  aliases: Record<string, string>;
}

interface ModelsCacheConfig extends Partial<ModelsConfig> {
  planSnapshots?: Record<string, CodexModelInfo[]>;
}

/**
 * Raw model entry from backend (fields are optional — format may vary).
 */
export interface BackendModelEntry {
  slug?: string;
  id?: string;
  name?: string;
  display_name?: string;
  description?: string;
  is_default?: boolean;
  default_reasoning_effort?: string;
  default_reasoning_level?: string;
  supported_reasoning_efforts?: Array<{
    reasoning_effort?: string;
    reasoningEffort?: string;
    effort?: string;
    description?: string;
  }>;
  supported_reasoning_levels?: Array<{
    effort?: string;
    description?: string;
  }>;
  input_modalities?: string[];
  output_modalities?: string[];
  supports_personality?: boolean;
  upgrade?: string | null;
  prefer_websockets?: boolean;
  context_window?: number;
  contextWindow?: number;
  max_context_window?: number;
  maxContextWindow?: number;
  max_output_tokens?: number;
  maxOutputTokens?: number;
  auto_compact_token_limit?: number | null;
  autoCompactTokenLimit?: number | null;
  truncation_policy?: {
    limit?: number;
  };
  truncationPolicy?: {
    limit?: number;
  };
  available_in_plans?: string[];
  priority?: number;
  visibility?: string;
}

type ConfiguredCustomModel = AppConfig["model"]["custom_models"][number];

export interface ParsedModelName {
  modelId: string;
  serviceTier: string | null;
  reasoningEffort: string | null;
}

/** Intermediate type with explicit efforts flag for merge logic. */
interface NormalizedModelWithMeta extends CodexModelInfo {
  _hasExplicitEfforts: boolean;
}

// ── Constants ────────────────────────────────────────────────────────

const SERVICE_TIER_SUFFIXES = new Set(["fast", "flex"]);
const EFFORT_SUFFIXES = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
/** ChatGPT UI selectors that are not valid Codex model IDs. */
const CHATGPT_ONLY_MODEL_IDS = new Set(["auto"]);

export const KNOWN_OFFICIAL_MODELS: ReadonlyMap<string, CodexModelInfo> = new Map<string, CodexModelInfo>([
  [
    "gpt-6-astra",
    {
      id: "gpt-6-astra",
      displayName: "GPT-6 Astra",
      description: "Flagship frontier model for complex reasoning, coding, and end-to-end agentic work.",
      isDefault: false,
      contextWindow: 1050000,
      maxContextWindow: 1050000,
      maxOutputTokens: 128000,
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "Fast responses with lighter reasoning" },
        { reasoningEffort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
        { reasoningEffort: "high", description: "Greater reasoning depth for complex problems" },
        { reasoningEffort: "xhigh", description: "Extra high reasoning depth for complex problems" },
        { reasoningEffort: "max", description: "Maximum reasoning depth for the hardest problems" },
        { reasoningEffort: "ultra", description: "Maximum reasoning with automatic task delegation" },
      ],
      defaultReasoningEffort: "medium",
      supportsPersonality: false,
      upgrade: null,
      source: "static",
    },
  ],
  [
    "gpt-6-astra-aeon",
    {
      id: "gpt-6-astra-aeon",
      displayName: "GPT-6 Astra Aeon",
      description: "Specialized variant for long-horizon multi-agent tasks and extended reasoning runs.",
      isDefault: false,
      contextWindow: 1050000,
      maxContextWindow: 1050000,
      maxOutputTokens: 128000,
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "Fast responses with lighter reasoning" },
        { reasoningEffort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
        { reasoningEffort: "high", description: "Greater reasoning depth for complex problems" },
        { reasoningEffort: "xhigh", description: "Extra high reasoning depth for complex problems" },
        { reasoningEffort: "max", description: "Maximum reasoning depth for the hardest problems" },
        { reasoningEffort: "ultra", description: "Maximum reasoning with automatic task delegation" },
      ],
      defaultReasoningEffort: "high",
      supportsPersonality: false,
      upgrade: null,
      source: "static",
    },
  ],
  [
    "gpt-reserve",
    {
      id: "gpt-reserve",
      displayName: "GPT-Reserve",
      description: "Fast and affordable agentic coding model.",
      isDefault: false,
      contextWindow: 272000,
      maxContextWindow: 872000,
      maxOutputTokens: 128000,
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "Fast responses with lighter reasoning" },
        { reasoningEffort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
        { reasoningEffort: "high", description: "Greater reasoning depth for complex problems" },
        { reasoningEffort: "xhigh", description: "Extra high reasoning depth for complex problems" },
        { reasoningEffort: "max", description: "Maximum reasoning depth for the hardest problems" },
      ],
      defaultReasoningEffort: "medium",
      supportsPersonality: false,
      upgrade: null,
      source: "static",
    },
  ],
]);

export const BUILTIN_MODEL_ALIASES: Readonly<Record<string, string>> = {
  "gpt-6": "gpt-6-astra",
};

function isAdmittedBackendModel(model: Pick<CodexModelInfo, "id">): boolean {
  return !CHATGPT_ONLY_MODEL_IDS.has(model.id);
}

export function stripKnownModelSuffixes(input: string): {
  modelName: string;
  serviceTier: string | null;
  reasoningEffort: string | null;
} {
  let remaining = input.trim();
  let serviceTier: string | null = null;
  let reasoningEffort: string | null = null;

  for (const tier of SERVICE_TIER_SUFFIXES) {
    if (remaining.endsWith(`-${tier}`)) {
      serviceTier = tier;
      remaining = remaining.slice(0, -(tier.length + 1));
      break;
    }
  }

  for (const effort of EFFORT_SUFFIXES) {
    if (remaining.endsWith(`-${effort}`)) {
      reasoningEffort = effort;
      remaining = remaining.slice(0, -(effort.length + 1));
      break;
    }
  }

  return { modelName: remaining, serviceTier, reasoningEffort };
}

function normalizeAliases(input: Record<string, string> | undefined): Record<string, string> {
  const aliases: Record<string, string> = {};
  if (!input) return aliases;
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = rawKey.trim();
    const value = rawValue.trim();
    if (key && value) aliases[key] = value;
  }
  return aliases;
}

/**
 * Whether a model name matches the shape of an official Codex/OpenAI model,
 * e.g. `gpt-6-astra`, `gpt-5.6-sol`, `gpt-oss-*`, `codex-mini`, `o1`/`o3`/`o4`.
 *
 * This is a *shape* check, not an allowlist. It lets newly released models that
 * aren't in the local catalog yet be routed upstream without a per-model code
 * change. Whether a given name is actually served is decided by the upstream
 * backend. Mirrors the regex used in `UpstreamRouter#isKnownCodexModel` so both
 * code paths agree on what is "official-looking".
 */
const OFFICIAL_MODEL_SHAPE = /^(?:gpt|codex|o\d[\w.-]*)/i;

function isOfficialCodexShape(modelId: string): boolean {
  return OFFICIAL_MODEL_SHAPE.test(modelId.trim());
}

// ── Class ────────────────────────────────────────────────────────────

export class ModelStore {
  private catalog: CodexModelInfo[] = [];
  private aliases: Record<string, string> = {};
  private lastFetchTime: string | null = null;
  private planModelMap = new Map<string, Set<string>>();
  private planModelSnapshots = new Map<string, CodexModelInfo[]>();
  private modelPlanIndex = new Map<string, Set<string>>();
  private defaultModelFn: () => string;

  constructor(defaultModelFn?: () => string) {
    this.defaultModelFn = defaultModelFn ?? (() => getConfig().model.default);
  }

  // ── Static loading ──────────────────────────────────────────────

  loadStatic(configDir?: string): void {
    const dir = configDir ?? getConfigDir();
    const configPath = resolve(dir, "models.yaml");
    const raw = yaml.load(readFileSync(configPath, "utf-8")) as ModelsConfig;

    this.catalog = (raw.models ?? []).map((m) => ({ ...m, source: "static" as const }));
    this.aliases = this.getConfiguredAliases();
    this.planModelMap = new Map();
    this.planModelSnapshots = new Map();
    this.modelPlanIndex = new Map();

    try {
      const cachePath = resolve(getDataDir(), "models-cache.yaml");
      if (existsSync(cachePath)) {
        const cached = yaml.load(readFileSync(cachePath, "utf-8")) as ModelsCacheConfig;
        const planSnapshots = cached.planSnapshots ?? null;
        if (planSnapshots) {
          for (const [planType, models] of Object.entries(planSnapshots)) {
            const backendModels = models
              .filter(isAdmittedBackendModel)
              .map((m) => ({ ...m, source: "backend" as const }));
            this.planModelSnapshots.set(planType, backendModels);
            this.planModelMap.set(planType, new Set(backendModels.map((m) => m.id)));
          }
          this.rebuildCatalogFromPlanSnapshots();
          console.log(`[ModelStore] Loaded ${this.catalog.length} cached backend models from data/models-cache.yaml`);
        } else {
          const cachedModels = (cached.models ?? []).filter(isAdmittedBackendModel);
          this.catalog = cachedModels.map((m) => ({ ...m, source: "backend" as const }));
          if (this.catalog.length > 0) {
            this.planModelSnapshots.set("cache", this.catalog.map((m) => ({ ...m })));
            this.planModelMap.set("cache", new Set(this.catalog.map((m) => m.id)));
            this.rebuildPlanIndex();
            console.log(`[ModelStore] Loaded ${this.catalog.length} cached backend models from data/models-cache.yaml`);
          }
        }
      }
    } catch {
      // Cache missing or corrupt — safe to ignore, backend fetch will repopulate
    }

    const customCount = this.applyConfiguredCustomModels();
    if (customCount > 0) {
      console.log(`[ModelStore] Applied ${customCount} custom models from local config`);
    }
    console.log(`[ModelStore] Loaded ${this.catalog.length} models, ${Object.keys(this.aliases).length} configured aliases`);
  }

  // ── Backend merge ───────────────────────────────────────────────

  applyBackendModels(backendModels: BackendModelEntry[]): void {
    this.applyBackendModelsForPlan("default", backendModels);
  }

  applyBackendModelsForPlan(planType: string, backendModels: BackendModelEntry[]): void {
    const models = backendModels
      .map((raw) => stripNormalizeMetadata(normalizeBackendModel(raw)))
      .filter(isAdmittedBackendModel);
    const admittedIds = new Set(models.map((model) => model.id));

    this.planModelSnapshots.delete(planType);
    this.planModelMap.delete(planType);
    this.planModelSnapshots.set(planType, models);
    this.planModelMap.set(planType, admittedIds);
    this.rebuildCatalogFromPlanSnapshots();
    this.lastFetchTime = new Date().toISOString();

    console.log(`[ModelStore] Plan "${planType}": ${admittedIds.size} admitted models, ${this.planModelMap.size} plans tracked`);
    console.log(`[ModelStore] Rebuilt ${this.catalog.length} models from backend snapshots`);
    this.syncCache();
  }

  // ── Getters ─────────────────────────────────────────────────────

  getModelPlanTypes(modelId: string): string[] {
    return [...(this.modelPlanIndex.get(modelId) ?? [])];
  }

  isPlanFetched(planType: string): boolean {
    return this.planModelMap.has(planType);
  }

  resolveModelId(input: string): string {
    const trimmed = input.trim();
    const resolved = this.resolveAliasChain(trimmed);
    if (resolved !== trimmed) return resolved;
    if (this.catalog.some((m) => m.id === resolved)) return resolved;
    // The bare `codex` sentinel means "use the default model", not a literal ID.
    if (resolved === "codex") return this.defaultModelFn();
    // Recognized-but-not-catalogued official models route as-is rather than
    // silently falling back to the default model (shape check from #776).
    if (isOfficialCodexShape(resolved)) return resolved;
    return this.defaultModelFn();
  }

  isRecognizedModelName(input: string): boolean {
    const trimmed = input.trim();
    if (!trimmed) return false;

    if (
      this.aliases[trimmed]
      || this.catalog.some((m) => m.id === trimmed)
      || isOfficialCodexShape(trimmed)
    ) {
      return true;
    }

    const stripped = stripKnownModelSuffixes(trimmed);
    if (
      stripped.modelName === trimmed
      || (!stripped.serviceTier && !stripped.reasoningEffort)
    ) {
      return false;
    }

    return !!this.aliases[stripped.modelName]
      || this.catalog.some((m) => m.id === stripped.modelName)
      || isOfficialCodexShape(stripped.modelName);
  }

  parseModelName(input: string): ParsedModelName {
    const trimmed = input.trim();

    if (
      this.aliases[trimmed]
      || this.catalog.some((m) => m.id === trimmed)
    ) {
      return { modelId: this.resolveModelId(trimmed), serviceTier: null, reasoningEffort: null };
    }

    const stripped = stripKnownModelSuffixes(trimmed);
    const modelId = this.resolveModelId(stripped.modelName);
    const { serviceTier, reasoningEffort } = stripped;
    return { modelId, serviceTier, reasoningEffort };
  }

  buildDisplayModelName(parsed: ParsedModelName): string {
    let name = parsed.modelId;
    if (parsed.reasoningEffort) name += `-${parsed.reasoningEffort}`;
    if (parsed.serviceTier) name += `-${parsed.serviceTier}`;
    return name;
  }

  getModelInfo(modelId: string): CodexModelInfo | undefined {
    const key = BUILTIN_MODEL_ALIASES[modelId] ?? modelId;
    return this.catalog.find((m) => m.id === key) ?? KNOWN_OFFICIAL_MODELS.get(key);
  }

  getModelCatalog(): CodexModelInfo[] {
    const staticModels = [...KNOWN_OFFICIAL_MODELS.values()].filter(
      (m) => !this.catalog.some((c) => c.id === m.id),
    );
    return [...this.catalog, ...staticModels];
  }

  getModelAliases(): Record<string, string> {
    return { ...this.aliases };
  }

  getModelStoreDebug(): {
    totalModels: number;
    backendModels: number;
    staticOnlyModels: number;
    aliasCount: number;
    lastFetchTime: string | null;
    models: Array<{ id: string; source: string }>;
    planMap: Record<string, string[]>;
  } {
    const backendCount = this.catalog.filter((m) => m.source === "backend").length;
    const planMap: Record<string, string[]> = {};
    for (const [planType, modelIds] of this.planModelMap) {
      planMap[planType] = [...modelIds];
    }
    return {
      totalModels: this.catalog.length,
      backendModels: backendCount,
      staticOnlyModels: this.catalog.length - backendCount,
      aliasCount: Object.keys(this.aliases).length,
      lastFetchTime: this.lastFetchTime,
      models: this.catalog.map((m) => ({ id: m.id, source: m.source ?? "static" })),
      planMap,
    };
  }

  // ── Private ─────────────────────────────────────────────────────

  private syncCache(): void {
    const dataDir = getDataDir();
    const cachePath = resolve(dataDir, "models-cache.yaml");
    const today = new Date().toISOString().slice(0, 10);

    const planSnapshots: Record<string, CodexModelInfo[]> = {};
    for (const [planType, models] of this.planModelSnapshots) {
      planSnapshots[planType] = models.map(({ source: _s, ...rest }) => rest);
    }
    const modelCount = Object.values(planSnapshots).reduce((total, models) => total + models.length, 0);

    const header = [
      "# Codex model cache",
      "#",
      "# Auto-synced by model-store from backend fetch results.",
      "# This is a runtime cache — do NOT commit to git.",
      "#",
      `# Last updated: ${today}`,
      "",
    ].join("\n");

    const body = yaml.dump(
      { planSnapshots, aliases: {} },
      { lineWidth: 120, noRefs: true, sortKeys: false },
    );

    try {
      mkdirSync(dataDir, { recursive: true });
    } catch {
      // already exists
    }

    writeFile(cachePath, header + body, "utf-8", (err) => {
      if (err) {
        console.warn(`[ModelStore] Failed to sync models cache: ${err.message}`);
      } else {
        console.log(`[ModelStore] Synced ${modelCount} models to data/models-cache.yaml`);
      }
    });
  }

  private getConfiguredAliases(): Record<string, string> {
    try {
      return normalizeAliases(getConfig().model.aliases);
    } catch {
      return {};
    }
  }

  private getConfiguredCustomModels(): ConfiguredCustomModel[] {
    try {
      const customModels = getConfig().model.custom_models;
      return Array.isArray(customModels) ? customModels : [];
    } catch {
      return [];
    }
  }

  private applyConfiguredCustomModels(): number {
    let applied = 0;

    for (const raw of this.getConfiguredCustomModels()) {
      const model = normalizeCustomModel(raw);
      if (!model) continue;

      const existingIndex = this.catalog.findIndex((entry) => entry.id === model.id);
      if (existingIndex >= 0) {
        this.catalog[existingIndex] = model;
      } else {
        this.catalog.push(model);
      }
      applied++;
    }

    return applied;
  }

  private rebuildCatalogFromPlanSnapshots(): void {
    const modelsById = new Map<string, CodexModelInfo>();
    for (const models of this.planModelSnapshots.values()) {
      for (const model of models) {
        modelsById.set(model.id, { ...model, source: "backend" });
      }
    }
    this.catalog = [...modelsById.values()];
    this.applyConfiguredCustomModels();
    this.rebuildPlanIndex();
  }

  private rebuildPlanIndex(): void {
    this.modelPlanIndex = new Map();
    for (const [plan, modelIds] of this.planModelMap) {
      for (const id of modelIds) {
        let plans = this.modelPlanIndex.get(id);
        if (!plans) {
          plans = new Set();
          this.modelPlanIndex.set(id, plans);
        }
        plans.add(plan);
      }
    }
  }

  private resolveAliasChain(input: string): string {
    let current = input.trim();
    const seen = new Set<string>();

    for (let depth = 0; depth < 20; depth++) {
      const target = (this.aliases[current] ?? BUILTIN_MODEL_ALIASES[current])?.trim();
      if (!target) return current;
      if (seen.has(current) || seen.has(target)) return input.trim();
      seen.add(current);
      current = target;
    }

    return input.trim();
  }
}

// ── Helpers (module-level, stateless) ─────────────────────────────

function stripNormalizeMetadata(model: NormalizedModelWithMeta): CodexModelInfo {
  const { _hasExplicitEfforts: _meta, ...info } = model;
  return info;
}

function normalizeBackendModel(raw: BackendModelEntry): NormalizedModelWithMeta {
  const id = raw.slug ?? raw.id ?? raw.name ?? "unknown";

  const rawEfforts = raw.supported_reasoning_efforts ?? [];
  const rawLevels = raw.supported_reasoning_levels ?? [];
  const hasExplicitEfforts = rawEfforts.length > 0 || rawLevels.length > 0;

  const efforts = rawEfforts.length > 0
    ? rawEfforts.map((e) => ({
        reasoningEffort: e.reasoningEffort ?? e.reasoning_effort ?? e.effort ?? "medium",
        description: e.description ?? "",
      }))
    : rawLevels.map((e) => ({
        reasoningEffort: e.effort ?? "medium",
        description: e.description ?? "",
      }));

  const out: NormalizedModelWithMeta = {
    id,
    displayName: raw.display_name ?? raw.name ?? id,
    description: raw.description ?? "",
    isDefault: raw.is_default ?? false,
    supportedReasoningEfforts: efforts.length > 0
      ? efforts
      : [{ reasoningEffort: "medium", description: "Default" }],
    defaultReasoningEffort: raw.default_reasoning_effort ?? raw.default_reasoning_level ?? "medium",
    inputModalities: raw.input_modalities ?? ["text"],
    supportsPersonality: raw.supports_personality ?? false,
    upgrade: raw.upgrade ?? null,
    source: "backend",
    _hasExplicitEfforts: hasExplicitEfforts,
  };
  // Only set outputModalities when backend provided it — otherwise the spread
  // in applyBackendModels would clobber the static catalog value with undefined.
  if (raw.output_modalities) out.outputModalities = raw.output_modalities;
  if (typeof raw.context_window === "number") {
    out.contextWindow = raw.context_window;
  } else if (typeof raw.contextWindow === "number") {
    out.contextWindow = raw.contextWindow;
  }
  if (typeof raw.max_context_window === "number") {
    out.maxContextWindow = raw.max_context_window;
  } else if (typeof raw.maxContextWindow === "number") {
    out.maxContextWindow = raw.maxContextWindow;
  }
  if (typeof raw.max_output_tokens === "number") {
    out.maxOutputTokens = raw.max_output_tokens;
  } else if (typeof raw.maxOutputTokens === "number") {
    out.maxOutputTokens = raw.maxOutputTokens;
  }
  if (typeof raw.auto_compact_token_limit === "number") {
    out.autoCompactTokenLimit = raw.auto_compact_token_limit;
  } else if (typeof raw.autoCompactTokenLimit === "number") {
    out.autoCompactTokenLimit = raw.autoCompactTokenLimit;
  }
  if (typeof raw.truncation_policy?.limit === "number") {
    out.truncationPolicyLimit = raw.truncation_policy.limit;
  } else if (typeof raw.truncationPolicy?.limit === "number") {
    out.truncationPolicyLimit = raw.truncationPolicy.limit;
  }
  return out;
}

function normalizeCustomModel(raw: ConfiguredCustomModel): CodexModelInfo | null {
  if (typeof raw === "string") {
    const id = raw.trim();
    if (!id) return null;

    return buildCustomModel({
      id,
      displayName: id,
      description: "Custom Codex-compatible model",
      supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Default" }],
      defaultReasoningEffort: "medium",
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsPersonality: false,
    });
  }

  const id = raw.id.trim();
  if (!id) return null;

  const supportedReasoningEfforts = (raw.supported_reasoning_efforts ?? ["medium"]).map((effort) => {
    const reasoningEffort = effort.trim();
    return { reasoningEffort, description: reasoningEffort };
  });

  const model = buildCustomModel({
    id,
    displayName: raw.display_name ?? id,
    description: raw.description ?? "Custom Codex-compatible model",
    supportedReasoningEfforts,
    defaultReasoningEffort: raw.default_reasoning_effort ?? "medium",
    inputModalities: raw.input_modalities ?? ["text"],
    outputModalities: raw.output_modalities ?? ["text"],
    supportsPersonality: raw.supports_personality ?? false,
  });

  if (typeof raw.context_window === "number") model.contextWindow = raw.context_window;
  if (typeof raw.max_context_window === "number") model.maxContextWindow = raw.max_context_window;
  if (typeof raw.max_output_tokens === "number") model.maxOutputTokens = raw.max_output_tokens;
  if (typeof raw.truncation_policy_limit === "number") model.truncationPolicyLimit = raw.truncation_policy_limit;

  return model;
}

function buildCustomModel(
  input: Pick<
    CodexModelInfo,
    | "id"
    | "displayName"
    | "description"
    | "supportedReasoningEfforts"
    | "defaultReasoningEffort"
    | "inputModalities"
    | "outputModalities"
    | "supportsPersonality"
  >,
): CodexModelInfo {
  return {
    ...input,
    isDefault: false,
    upgrade: null,
    source: "custom",
  };
}

// ── Default instance + backward-compatible free functions ─────────

let _instance: ModelStore = new ModelStore();

/** Get the default ModelStore instance. */
export function getModelStore(): ModelStore {
  return _instance;
}

/** Test-only: replace the default instance. */
export function setModelStoreForTesting(store: ModelStore): void {
  _instance = store;
}

/** Test-only: reset to a fresh default instance. */
export function resetModelStoreForTesting(): void {
  _instance = new ModelStore();
}

// Free-function wrappers — delegate to _instance for backward compat.
// Callers can gradually migrate to using ModelStore directly.

export function loadStaticModels(configDir?: string): void {
  _instance.loadStatic(configDir);
}

export function applyBackendModels(backendModels: BackendModelEntry[]): void {
  _instance.applyBackendModels(backendModels);
}

export function applyBackendModelsForPlan(planType: string, backendModels: BackendModelEntry[]): void {
  _instance.applyBackendModelsForPlan(planType, backendModels);
}

export function getModelPlanTypes(modelId: string): string[] {
  return _instance.getModelPlanTypes(modelId);
}

export function isPlanFetched(planType: string): boolean {
  return _instance.isPlanFetched(planType);
}

export function resolveModelId(input: string): string {
  return _instance.resolveModelId(input);
}

/**
 * Whether a client-supplied model name is requestable through the default
 * Codex/account path (as opposed to an api-key/adapter route).
 *
 * Treats the "codex" sentinel (used when a client omits the model) and the
 * configured default model as valid, since both legitimately resolve to the
 * default model. Any other name that is neither a catalog entry nor an alias
 * is unrecognised and should be rejected rather than silently defaulted.
 */
export function isRequestableModel(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) return false;
  if (trimmed === "codex") return true;
  const defaultModel = getConfig().model.default;
  if (defaultModel && trimmed === defaultModel) return true;

  // The `codex` sentinel has no catalog entry, so a model built from it with a
  // known suffix (e.g. `codex-high-fast`, `codex-fast`) would not be found by
  // isRecognizedModelName. Strip known suffixes first: if the base name is the
  // sentinel or the configured default model, the suffixed form is requestable
  // too. Unknown names such as `gpt-9999` still fall through and are rejected.
  const stripped = stripKnownModelSuffixes(trimmed);
  if (stripped.modelName !== trimmed) {
    if (stripped.modelName === "codex" || (defaultModel && stripped.modelName === defaultModel)) {
      return true;
    }
  }

  return _instance.isRecognizedModelName(trimmed);
}

export function isRecognizedModelName(input: string): boolean {
  return _instance.isRecognizedModelName(input);
}

export function parseModelName(input: string): ParsedModelName {
  return _instance.parseModelName(input);
}

export function buildDisplayModelName(parsed: ParsedModelName): string {
  return _instance.buildDisplayModelName(parsed);
}

export function getModelInfo(modelId: string): CodexModelInfo | undefined {
  return _instance.getModelInfo(modelId);
}

export function getModelCatalog(): CodexModelInfo[] {
  return _instance.getModelCatalog();
}

export function getModelAliases(): Record<string, string> {
  return _instance.getModelAliases();
}

export function getModelStoreDebug() {
  return _instance.getModelStoreDebug();
}
