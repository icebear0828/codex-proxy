/**
 * Official model catalog sync — pulls the Codex model manifest published in
 * the openai/codex repository and keeps a local snapshot.
 *
 * This is the third source of model data (after the authenticated backend
 * fetch and the handwritten static fallback): it needs no account or
 * credentials, so a cold start can advertise current official models even
 * before any plan snapshot is available. Failures are always silent (null)
 * and never throw — callers fall back to the backend fetch.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { getDataDir } from "../paths.js";
import type { BackendModelEntry, CodexModelInfo } from "./model-store.js";

export const DEFAULT_OFFICIAL_CATALOG_URL =
  "https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json";

const DEFAULT_TIMEOUT_MS = 8_000;
const CACHE_FILE_NAME = "official-model-catalog.json";

export interface OfficialCatalogSnapshot {
  fetchedAt: string;
  sourceUrl: string;
  models: CodexModelInfo[];
}

export interface OfficialCatalogSyncOptions {
  fetchFn?: typeof fetch;
  now?: () => Date;
  cacheFile?: string;
  sourceUrl?: string;
  timeoutMs?: number;
}

/** Raw entry shape from the official models.json manifest. */
interface RawOfficialModel {
  slug?: unknown;
  display_name?: unknown;
  description?: unknown;
  context_window?: unknown;
  max_context_window?: unknown;
  max_output_tokens?: unknown;
  auto_compact_token_limit?: unknown;
  default_reasoning_level?: unknown;
  supported_reasoning_levels?: unknown;
  input_modalities?: unknown;
  output_modalities?: unknown;
  visibility?: unknown;
  supported_in_api?: unknown;
  priority?: unknown;
  upgrade?: unknown;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Map one official manifest entry; returns null when it must not be exposed. */
function mapOfficialModel(raw: RawOfficialModel): CodexModelInfo | null {
  if (!raw || typeof raw !== "object") return null;

  const id = typeof raw.slug === "string" ? raw.slug.trim() : "";
  if (!id) return null;
  // Only models the API actually serves, and only picker-visible ones:
  // hidden entries (e.g. daybreak/auto-review) are still supported_in_api
  // but must not be advertised to clients.
  if (raw.supported_in_api !== true) return null;
  if (raw.visibility !== "list") return null;

  const levels = Array.isArray(raw.supported_reasoning_levels)
    ? raw.supported_reasoning_levels
        .filter((l): l is { effort?: unknown; description?: unknown } => !!l && typeof l === "object")
        .map((l) => ({
          reasoningEffort: typeof l.effort === "string" ? l.effort : "medium",
          description: typeof l.description === "string" ? l.description : "",
        }))
    : [];

  const model: CodexModelInfo = {
    id,
    displayName: typeof raw.display_name === "string" && raw.display_name.trim() ? raw.display_name : id,
    description: typeof raw.description === "string" ? raw.description : "",
    isDefault: false,
    supportedReasoningEfforts: levels.length > 0
      ? levels
      : [{ reasoningEffort: "medium", description: "Default" }],
    defaultReasoningEffort: typeof raw.default_reasoning_level === "string"
      ? raw.default_reasoning_level
      : "medium",
    inputModalities: isStringArray(raw.input_modalities) ? raw.input_modalities : ["text"],
    supportsPersonality: false,
    upgrade: typeof raw.upgrade === "string" && raw.upgrade.trim() ? raw.upgrade : null,
    source: "static",
    supportedInApi: true,
  };

  if (isStringArray(raw.output_modalities)) model.outputModalities = raw.output_modalities;
  const contextWindow = optionalNumber(raw.context_window);
  if (contextWindow !== undefined) model.contextWindow = contextWindow;
  const maxContextWindow = optionalNumber(raw.max_context_window);
  if (maxContextWindow !== undefined) model.maxContextWindow = maxContextWindow;
  const maxOutputTokens = optionalNumber(raw.max_output_tokens);
  if (maxOutputTokens !== undefined) model.maxOutputTokens = maxOutputTokens;
  const autoCompactTokenLimit = optionalNumber(raw.auto_compact_token_limit);
  if (autoCompactTokenLimit !== undefined) model.autoCompactTokenLimit = autoCompactTokenLimit;
  if (typeof raw.visibility === "string") model.visibility = raw.visibility;
  const priority = optionalNumber(raw.priority);
  if (priority !== undefined) model.priority = priority;

  return model;
}

/**
 * Convert mapped model info back into the snake_case backend payload accepted
 * by `ModelStore.applyBackendModelsForPlan()`.
 */
export function toBackendModelEntries(models: CodexModelInfo[]): BackendModelEntry[] {
  return models.map((m) => {
    const entry: BackendModelEntry = {
      slug: m.id,
      display_name: m.displayName,
      description: m.description,
      default_reasoning_level: m.defaultReasoningEffort,
      supported_reasoning_levels: m.supportedReasoningEfforts.map((e) => ({
        effort: e.reasoningEffort,
        description: e.description,
      })),
      input_modalities: m.inputModalities,
      supports_personality: m.supportsPersonality,
      upgrade: m.upgrade,
    };
    if (m.outputModalities) entry.output_modalities = m.outputModalities;
    if (typeof m.contextWindow === "number") entry.context_window = m.contextWindow;
    if (typeof m.maxContextWindow === "number") entry.max_context_window = m.maxContextWindow;
    if (typeof m.maxOutputTokens === "number") entry.max_output_tokens = m.maxOutputTokens;
    if (typeof m.autoCompactTokenLimit === "number") {
      entry.auto_compact_token_limit = m.autoCompactTokenLimit;
    }
    if (typeof m.visibility === "string") entry.visibility = m.visibility;
    if (typeof m.priority === "number") entry.priority = m.priority;
    if (typeof m.supportedInApi === "boolean") entry.supported_in_api = m.supportedInApi;
    return entry;
  });
}

export class OfficialCatalogSync {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;
  private readonly cacheFile: string;
  readonly sourceUrl: string;
  private readonly timeoutMs: number;
  private snapshot: OfficialCatalogSnapshot | null = null;

  constructor(options: OfficialCatalogSyncOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.cacheFile = options.cacheFile ?? resolve(getDataDir(), CACHE_FILE_NAME);
    this.sourceUrl = options.sourceUrl ?? DEFAULT_OFFICIAL_CATALOG_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.snapshot = this.loadCached();
  }

  /** Read the last successful snapshot; missing/corrupt cache yields null. */
  loadCached(): OfficialCatalogSnapshot | null {
    try {
      const parsed = JSON.parse(readFileSync(this.cacheFile, "utf-8")) as unknown;
      if (!parsed || typeof parsed !== "object") return null;
      const raw = parsed as { fetchedAt?: unknown; sourceUrl?: unknown; models?: unknown };
      if (!Array.isArray(raw.models)) return null;
      const models = raw.models.filter(
        (m): m is CodexModelInfo =>
          !!m && typeof m === "object" && typeof (m as { id?: unknown }).id === "string"
          && (m as { id: string }).id.trim().length > 0,
      );
      if (models.length === 0) return null;
      const snapshot: OfficialCatalogSnapshot = {
        fetchedAt: typeof raw.fetchedAt === "string" ? raw.fetchedAt : new Date(0).toISOString(),
        sourceUrl: typeof raw.sourceUrl === "string" ? raw.sourceUrl : this.sourceUrl,
        models: models.map((m) => ({ ...m, source: "static" as const })),
      };
      this.snapshot = snapshot;
      return snapshot;
    } catch {
      return null;
    }
  }

  /** Fetch the official manifest, validate it, and atomically persist the snapshot. */
  async fetchAndSave(): Promise<OfficialCatalogSnapshot | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(this.sourceUrl, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      if (!res || !res.ok) return null;

      const payload = (await res.json()) as unknown;
      if (!payload || typeof payload !== "object") return null;
      const rawModels = (payload as { models?: unknown }).models;
      if (!Array.isArray(rawModels) || rawModels.length === 0) return null;

      const seen = new Set<string>();
      const models: CodexModelInfo[] = [];
      for (const raw of rawModels) {
        const model = mapOfficialModel(raw as RawOfficialModel);
        if (!model || seen.has(model.id)) continue;
        seen.add(model.id);
        models.push(model);
      }
      if (models.length === 0) return null;

      const snapshot: OfficialCatalogSnapshot = {
        fetchedAt: this.now().toISOString(),
        sourceUrl: this.sourceUrl,
        models,
      };
      this.writeSnapshot(snapshot);
      this.snapshot = snapshot;
      return snapshot;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  getModels(): CodexModelInfo[] {
    return this.snapshot ? [...this.snapshot.models] : [];
  }

  getSnapshot(): OfficialCatalogSnapshot | null {
    return this.snapshot;
  }

  private writeSnapshot(snapshot: OfficialCatalogSnapshot): void {
    mkdirSync(dirname(this.cacheFile), { recursive: true });
    const tmp = `${this.cacheFile}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(snapshot, null, 2), "utf-8");
    renameSync(tmp, this.cacheFile);
  }
}
