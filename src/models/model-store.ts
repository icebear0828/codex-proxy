/**
 * Model Store — mutable singleton for model catalog + aliases.
 *
 * Data flow:
 *   1. loadStaticModels() — load from config/models.yaml (fallback baseline)
 *   2. applyBackendModels() — merge backend-fetched models (backend wins for shared IDs)
 *   3. getters — runtime reads from mutable state
 *
 * Aliases always come from YAML (user-customizable), never from backend.
 */

import { readFileSync, writeFile, existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import yaml from "js-yaml";
import { getConfig } from "../config.js";
import { getConfigDir, getDataDir } from "../paths.js";

export interface CodexModelInfo {
  id: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
  defaultReasoningEffort: string;
  inputModalities: string[];
  supportsPersonality: boolean;
  upgrade: string | null;
  /** Where this model entry came from */
  source?: "static" | "backend";
}

interface ModelsConfig {
  models: CodexModelInfo[];
  aliases: Record<string, string>;
}

// ── Mutable state ──────────────────────────────────────────────────

let _catalog: CodexModelInfo[] = [];
let _aliases: Record<string, string> = {};
let _lastFetchTime: string | null = null;
/** planType → Set<modelId> — write path: bulk replace per plan */
let _planModelMap: Map<string, Set<string>> = new Map();
/** modelId → Set<planType> — read path: O(1) lookup for routing */
let _modelPlanIndex: Map<string, Set<string>> = new Map();

// ── Static loading ─────────────────────────────────────────────────

/**
 * Load models from config/models.yaml (synchronous).
 * Called at startup and on hot-reload.
 */
export function loadStaticModels(configDir?: string): void {
  const dir = configDir ?? getConfigDir();
  const configPath = resolve(dir, "models.yaml");
  const raw = yaml.load(readFileSync(configPath, "utf-8")) as ModelsConfig;

  _catalog = (raw.models ?? []).map((m) => ({ ...m, source: "static" as const }));
  _aliases = raw.aliases ?? {};
  _planModelMap = new Map(); // Reset plan maps on reload
  _modelPlanIndex = new Map();
  console.log(`[ModelStore] Loaded ${_catalog.length} static models, ${Object.keys(_aliases).length} aliases`);

  // Overlay cached backend models from data/ (cold-start fallback)
  try {
    const cachePath = resolve(getDataDir(), "models-cache.yaml");
    if (existsSync(cachePath)) {
      const cached = yaml.load(readFileSync(cachePath, "utf-8")) as ModelsConfig;
      const cachedModels = cached.models ?? [];
      if (cachedModels.length > 0) {
        const staticIds = new Set(_catalog.map((m) => m.id));
        let added = 0;
        for (const m of cachedModels) {
          if (!staticIds.has(m.id)) {
            _catalog.push({ ...m, source: "backend" as const });
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

// ── Backend merge ──────────────────────────────────────────────────

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
  supports_personality?: boolean;
  upgrade?: string | null;
  prefer_websockets?: boolean;
  context_window?: number;
  available_in_plans?: string[];
  priority?: number;
  visibility?: string;
}

/** Intermediate type with explicit efforts flag for merge logic. */
interface NormalizedModelWithMeta extends CodexModelInfo {
  _hasExplicitEfforts: boolean;
}

/**
 * Normalize a backend model entry to our CodexModelInfo format.
 */
function normalizeBackendModel(raw: BackendModelEntry): NormalizedModelWithMeta {
  const id = raw.slug ?? raw.id ?? raw.name ?? "unknown";

  // Accept both old (supported_reasoning_efforts) and new (supported_reasoning_levels) field names
  const rawEfforts = raw.supported_reasoning_efforts ?? [];
  const rawLevels = raw.supported_reasoning_levels ?? [];
  const hasExplicitEfforts = rawEfforts.length > 0 || rawLevels.length > 0;

  // Normalize reasoning efforts — accept effort, reasoning_effort, reasoningEffort keys
  const efforts = rawEfforts.length > 0
    ? rawEfforts.map((e) => ({
        reasoningEffort: e.reasoningEffort ?? e.reasoning_effort ?? e.effort ?? "medium",
        description: e.description ?? "",
      }))
    : rawLevels.map((e) => ({
        reasoningEffort: e.effort ?? "medium",
        description: e.description ?? "",
      }));

  return {
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
}

/**
 * Merge backend models into the catalog.
 *
 * Strategy:
 *   - Trust backend: all models returned by the backend are accepted
 *     (primary endpoint /codex/models only returns Codex-compatible models)
 *   - Backend models overwrite static models with the same ID
 *     (but YAML fields fill in missing backend fields)
 *   - Static-only models are preserved (YAML may know about models the backend doesn't list)
 *   - Aliases are never touched (always from YAML)
 */
export function applyBackendModels(backendModels: BackendModelEntry[]): void {
  const filtered = backendModels;

  const staticMap = new Map(_catalog.map((m) => [m.id, m]));
  const merged: CodexModelInfo[] = [];
  const seenIds = new Set<string>();

  for (const raw of filtered) {
    const normalized = normalizeBackendModel(raw);
    seenIds.add(normalized.id);

    const existing = staticMap.get(normalized.id);
    // Strip internal meta field before storing
    const { _hasExplicitEfforts, ...model } = normalized;
    if (existing) {
      // Backend wins, but YAML fills gaps
      merged.push({
        ...existing,
        ...model,
        // Preserve YAML fields if backend is empty
        description: model.description || existing.description,
        displayName: model.displayName || existing.displayName,
        supportedReasoningEfforts: _hasExplicitEfforts
          ? model.supportedReasoningEfforts
          : existing.supportedReasoningEfforts,
        source: "backend",
      });
    } else {
      merged.push(model);
    }
  }

  // Preserve static-only models (not in backend)
  for (const m of _catalog) {
    if (!seenIds.has(m.id)) {
      merged.push({ ...m, source: "static" });
    }
  }

  _catalog = merged;
  _lastFetchTime = new Date().toISOString();
  console.log(
    `[ModelStore] Merged ${filtered.length} backend + ${merged.length - filtered.length} static-only = ${merged.length} total models`,
  );

  // Auto-sync merged catalog back to models.yaml
  syncStaticModels();
}

/**
 * Write the current merged catalog to data/models-cache.yaml so it serves
 * as a fallback for future cold starts.  Fire-and-forget.
 *
 * config/models.yaml stays read-only (git-tracked baseline).
 */
function syncStaticModels(): void {
  const dataDir = getDataDir();
  const cachePath = resolve(dataDir, "models-cache.yaml");
  const today = new Date().toISOString().slice(0, 10);

  // Strip internal `source` field before serializing
  const models = _catalog.map(({ source: _s, ...rest }) => rest);

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
    { models, aliases: _aliases },
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

/**
 * Merge backend models for a specific plan type.
 * Clears old records for this planType, applies merge, then records plan→model mappings.
 */
export function applyBackendModelsForPlan(planType: string, backendModels: BackendModelEntry[]): void {
  // Merge into catalog (existing logic)
  applyBackendModels(backendModels);

  // Build new model set for this plan and replace atomically
  const admittedIds = new Set<string>();
  for (const raw of backendModels) {
    const id = raw.slug ?? raw.id ?? raw.name ?? "";
    if (id) admittedIds.add(id);
  }
  _planModelMap.set(planType, admittedIds);

  // Rebuild reverse index from scratch (plan types are few, this is cheap)
  _modelPlanIndex = new Map();
  for (const [plan, modelIds] of _planModelMap) {
    for (const id of modelIds) {
      let plans = _modelPlanIndex.get(id);
      if (!plans) {
        plans = new Set();
        _modelPlanIndex.set(id, plans);
      }
      plans.add(plan);
    }
  }

  console.log(`[ModelStore] Plan "${planType}": ${admittedIds.size} admitted models, ${_planModelMap.size} plans tracked`);
}

/**
 * Get which plan types are known to support a given model.
 * Empty array means unknown (static-only or not yet fetched).
 */
export function getModelPlanTypes(modelId: string): string[] {
  return [...(_modelPlanIndex.get(modelId) ?? [])];
}

// ── Model name suffix parsing ───────────────────────────────────────

export interface ParsedModelName {
  modelId: string;
  serviceTier: string | null;
  reasoningEffort: string | null;
}

const SERVICE_TIER_SUFFIXES = new Set(["fast", "flex"]);
const EFFORT_SUFFIXES = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);

/**
 * Parse a model name that may contain embedded suffixes for service_tier and reasoning_effort.
 *
 * Resolution:
 *   1. If full name is a known model ID or alias → use as-is
 *   2. Otherwise, strip known suffixes from right:
 *      - `-fast`, `-flex` → service_tier
 *      - `-minimal`, `-low`, `-medium`, `-high`, `-xhigh` → reasoning_effort
 *   3. Resolve remaining name as model ID/alias
 */
export function parseModelName(input: string): ParsedModelName {
  const trimmed = input.trim();

  // 1. Known model or alias? Use as-is
  if (_aliases[trimmed] || _catalog.some((m) => m.id === trimmed)) {
    return { modelId: resolveModelId(trimmed), serviceTier: null, reasoningEffort: null };
  }

  // 2. Try stripping suffixes from right
  let remaining = trimmed;
  let serviceTier: string | null = null;
  let reasoningEffort: string | null = null;

  // Strip -fast/-flex (rightmost)
  for (const tier of SERVICE_TIER_SUFFIXES) {
    if (remaining.endsWith(`-${tier}`)) {
      serviceTier = tier;
      remaining = remaining.slice(0, -(tier.length + 1));
      break;
    }
  }

  // Strip -high/-low/etc (next from right)
  for (const effort of EFFORT_SUFFIXES) {
    if (remaining.endsWith(`-${effort}`)) {
      reasoningEffort = effort;
      remaining = remaining.slice(0, -(effort.length + 1));
      break;
    }
  }

  // 3. Resolve remaining as model
  const modelId = resolveModelId(remaining);
  return { modelId, serviceTier, reasoningEffort };
}

/** Reconstruct display model name: resolved modelId + any parsed suffixes. */
export function buildDisplayModelName(parsed: ParsedModelName): string {
  let name = parsed.modelId;
  if (parsed.reasoningEffort) name += `-${parsed.reasoningEffort}`;
  if (parsed.serviceTier) name += `-${parsed.serviceTier}`;
  return name;
}

// ── Getters ────────────────────────────────────────────────────────

/**
 * Resolve a model name (may be an alias) to a canonical model ID.
 */
export function resolveModelId(input: string): string {
  const trimmed = input.trim();
  if (_aliases[trimmed]) return _aliases[trimmed];
  if (_catalog.some((m) => m.id === trimmed)) return trimmed;
  return getConfig().model.default;
}

/**
 * Get model info by ID.
 */
export function getModelInfo(modelId: string): CodexModelInfo | undefined {
  return _catalog.find((m) => m.id === modelId);
}

/**
 * Get the full model catalog.
 */
export function getModelCatalog(): CodexModelInfo[] {
  return [..._catalog];
}

/**
 * Get the alias map.
 */
export function getModelAliases(): Record<string, string> {
  return { ..._aliases };
}

/**
 * Debug info for /debug/models endpoint.
 */
export function getModelStoreDebug(): {
  totalModels: number;
  backendModels: number;
  staticOnlyModels: number;
  aliasCount: number;
  lastFetchTime: string | null;
  models: Array<{ id: string; source: string }>;
  planMap: Record<string, string[]>;
} {
  const backendCount = _catalog.filter((m) => m.source === "backend").length;
  const planMap: Record<string, string[]> = {};
  for (const [planType, modelIds] of _planModelMap) {
    planMap[planType] = [...modelIds];
  }
  return {
    totalModels: _catalog.length,
    backendModels: backendCount,
    staticOnlyModels: _catalog.length - backendCount,
    aliasCount: Object.keys(_aliases).length,
    lastFetchTime: _lastFetchTime,
    models: _catalog.map((m) => ({ id: m.id, source: m.source ?? "static" })),
    planMap,
  };
}
