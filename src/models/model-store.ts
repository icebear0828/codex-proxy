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

import { readFileSync } from "fs";
import { resolve } from "path";
import yaml from "js-yaml";
import { getConfig } from "../config.js";
import { getConfigDir } from "../paths.js";

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
  console.log(`[ModelStore] Loaded ${_catalog.length} static models, ${Object.keys(_aliases).length} aliases`);
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
  supported_reasoning_efforts?: Array<{
    reasoning_effort?: string;
    reasoningEffort?: string;
    description?: string;
  }>;
  input_modalities?: string[];
  supports_personality?: boolean;
  upgrade?: string | null;
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

  const hasExplicitEfforts = Array.isArray(raw.supported_reasoning_efforts) && raw.supported_reasoning_efforts.length > 0;

  // Normalize reasoning efforts — accept both snake_case and camelCase
  const efforts = (raw.supported_reasoning_efforts ?? []).map((e) => ({
    reasoningEffort: e.reasoningEffort ?? e.reasoning_effort ?? "medium",
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
    defaultReasoningEffort: raw.default_reasoning_effort ?? "medium",
    inputModalities: raw.input_modalities ?? ["text"],
    supportsPersonality: raw.supports_personality ?? false,
    upgrade: raw.upgrade ?? null,
    source: "backend",
    _hasExplicitEfforts: hasExplicitEfforts,
  };
}

/** Check if a model ID is Codex-compatible (gpt-X.Y-codex-* or bare gpt-X.Y). */
function isCodexCompatibleId(id: string): boolean {
  if (/^gpt-\d+(\.\d+)?-codex/.test(id)) return true;
  if (/^gpt-\d+(\.\d+)?$/.test(id)) return true;
  return false;
}

/**
 * Merge backend models into the catalog.
 *
 * Strategy:
 *   - Backend models overwrite static models with the same ID
 *     (but YAML fields fill in missing backend fields)
 *   - Static-only models are preserved (YAML may know about models the backend doesn't list)
 *   - New Codex models from backend are auto-admitted (prevents missing new releases)
 *   - Aliases are never touched (always from YAML)
 */
export function applyBackendModels(backendModels: BackendModelEntry[]): void {
  // Keep models that either exist in static catalog OR are Codex models.
  // This prevents ChatGPT-only slugs (gpt-5-2, research, etc.) from
  // entering the catalog, while auto-admitting new Codex releases.
  const staticIds = new Set(_catalog.map((m) => m.id));
  const filtered = backendModels.filter((raw) => {
    const id = raw.slug ?? raw.id ?? raw.name ?? "";
    return staticIds.has(id) || isCodexCompatibleId(id);
  });

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
  const skipped = backendModels.length - filtered.length;
  console.log(
    `[ModelStore] Merged ${filtered.length} backend (${skipped} non-codex skipped) + ${merged.length - filtered.length} static-only = ${merged.length} total models`,
  );
}

// ── Model name suffix parsing ───────────────────────────────────────

export interface ParsedModelName {
  modelId: string;
  serviceTier: string | null;
  reasoningEffort: string | null;
}

const SERVICE_TIER_SUFFIXES = new Set(["fast", "flex"]);
const EFFORT_SUFFIXES = new Set(["minimal", "low", "medium", "high", "xhigh"]);

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
} {
  const backendCount = _catalog.filter((m) => m.source === "backend").length;
  return {
    totalModels: _catalog.length,
    backendModels: backendCount,
    staticOnlyModels: _catalog.length - backendCount,
    aliasCount: Object.keys(_aliases).length,
    lastFetchTime: _lastFetchTime,
    models: _catalog.map((m) => ({ id: m.id, source: m.source ?? "static" })),
  };
}
