/**
 * Model Store — manages model catalog + aliases.
 *
 * Data flow:
 *   1. loadStatic() — load from config/models.yaml (fallback baseline)
 *   2. applyBackendModels() — merge backend-fetched models (backend wins for shared IDs)
 *   3. getters — runtime reads from mutable state
 *
 * Aliases always come from YAML (user-customizable), never from backend.
 *
 * The ModelStore class owns all state. Module-level free functions delegate
 * to a default instance for backward compatibility.
 */

import { readFileSync, writeFile, existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import yaml from "js-yaml";
import { getConfig } from "../config.js";
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
  /** Where this model entry came from */
  source?: "static" | "backend";
}

interface ModelsConfig {
  models: CodexModelInfo[];
  aliases: Record<string, string>;
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
  available_in_plans?: string[];
  priority?: number;
  visibility?: string;
}

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
const EFFORT_SUFFIXES = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);

function stripKnownModelSuffixes(input: string): {
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

// ── Class ────────────────────────────────────────────────────────────

export class ModelStore {
  private catalog: CodexModelInfo[] = [];
  private aliases: Record<string, string> = {};
  private lastFetchTime: string | null = null;
  private planModelMap = new Map<string, Set<string>>();
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
    this.aliases = raw.aliases ?? {};
    this.planModelMap = new Map();
    this.modelPlanIndex = new Map();
    console.log(`[ModelStore] Loaded ${this.catalog.length} static models, ${Object.keys(this.aliases).length} aliases`);

    // Overlay cached backend models from data/ (cold-start fallback)
    try {
      const cachePath = resolve(getDataDir(), "models-cache.yaml");
      if (existsSync(cachePath)) {
        const cached = yaml.load(readFileSync(cachePath, "utf-8")) as ModelsConfig;
        const cachedModels = cached.models ?? [];
        if (cachedModels.length > 0) {
          const staticIds = new Set(this.catalog.map((m) => m.id));
          let added = 0;
          for (const m of cachedModels) {
            if (!staticIds.has(m.id)) {
              this.catalog.push({ ...m, source: "backend" as const });
              added++;
            }
          }
          if (added > 0) {
            console.log(`[ModelStore] Overlaid ${added} cached backend models from data/models-cache.yaml`);
          }
        }
      }
    } catch {
      // Cache missing or corrupt — safe to ignore, backend fetch will repopulate
    }
  }

  // ── Backend merge ───────────────────────────────────────────────

  applyBackendModels(backendModels: BackendModelEntry[]): void {
    const staticMap = new Map(this.catalog.map((m) => [m.id, m]));
    const merged: CodexModelInfo[] = [];
    const seenIds = new Set<string>();

    for (const raw of backendModels) {
      const normalized = normalizeBackendModel(raw);
      seenIds.add(normalized.id);

      const existing = staticMap.get(normalized.id);
      const { _hasExplicitEfforts, ...model } = normalized;
      if (existing) {
        merged.push({
          ...existing,
          ...model,
          description: model.description || existing.description,
          displayName: model.displayName || existing.displayName,
          supportedReasoningEfforts: _hasExplicitEfforts
            ? model.supportedReasoningEfforts
            : existing.supportedReasoningEfforts,
          // Preserve static isDefault when backend doesn't explicitly mark a default.
          // Codex backend typically omits is_default for non-flagship models, which
          // would otherwise clobber our YAML-declared default to false.
          isDefault: raw.is_default === true ? true : existing.isDefault,
          source: "backend",
        });
      } else {
        merged.push(model);
      }
    }

    for (const m of this.catalog) {
      if (!seenIds.has(m.id)) {
        merged.push({ ...m, source: "static" });
      }
    }

    this.catalog = merged;
    this.lastFetchTime = new Date().toISOString();
    console.log(
      `[ModelStore] Merged ${backendModels.length} backend + ${merged.length - backendModels.length} static-only = ${merged.length} total models`,
    );

    this.syncCache();
  }

  applyBackendModelsForPlan(planType: string, backendModels: BackendModelEntry[]): void {
    this.applyBackendModels(backendModels);

    const admittedIds = new Set<string>();
    for (const raw of backendModels) {
      const id = raw.slug ?? raw.id ?? raw.name ?? "";
      if (id) admittedIds.add(id);
    }
    this.planModelMap.set(planType, admittedIds);

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

    console.log(`[ModelStore] Plan "${planType}": ${admittedIds.size} admitted models, ${this.planModelMap.size} plans tracked`);
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
    if (this.aliases[trimmed]) return this.aliases[trimmed];
    if (this.catalog.some((m) => m.id === trimmed)) return trimmed;
    return this.defaultModelFn();
  }

  isRecognizedModelName(input: string): boolean {
    const trimmed = input.trim();
    if (!trimmed) return false;

    if (this.aliases[trimmed] || this.catalog.some((m) => m.id === trimmed)) {
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
      || this.catalog.some((m) => m.id === stripped.modelName);
  }

  parseModelName(input: string): ParsedModelName {
    const trimmed = input.trim();

    if (this.aliases[trimmed] || this.catalog.some((m) => m.id === trimmed)) {
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
    return this.catalog.find((m) => m.id === modelId);
  }

  getModelCatalog(): CodexModelInfo[] {
    return [...this.catalog];
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

    const models = this.catalog.map(({ source: _s, ...rest }) => rest);

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
      { models, aliases: this.aliases },
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
        console.log(`[ModelStore] Synced ${models.length} models to data/models-cache.yaml`);
      }
    });
  }
}

// ── Helpers (module-level, stateless) ─────────────────────────────

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
  return out;
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
