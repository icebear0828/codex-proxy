/**
 * ApiKeyPool — CRUD + persistence for third-party API keys.
 *
 * Each entry binds one API key to one specific model.
 * Built-in providers (openai/anthropic/gemini) have default base URLs;
 * custom providers require a user-supplied base URL.
 */

import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdirSync,
} from "fs";
import { resolve, dirname } from "path";
import { randomBytes } from "crypto";
import { getDataDir } from "../paths.js";
import type { ApiKeyProvider } from "./api-key-catalog.js";
import { isBuiltinProvider, PROVIDER_CATALOG } from "./api-key-catalog.js";

// ── Types ──────────────────────────────────────────────────────────

export type ApiKeyStatus = "active" | "disabled" | "error";
const ANTIGRAVITY_USAGE_WINDOW_MS = 5 * 60 * 60 * 1000;
export const API_KEY_CAPABILITIES = ["chat", "embeddings"] as const;
export type ApiKeyCapability = typeof API_KEY_CAPABILITIES[number];

/**
 * Upstream wire protocol for runtime API-key providers.
 * "chat" → OpenAI-compatible POST /chat/completions.
 * "responses" → OpenAI-compatible POST /responses.
 * "codex-responses" → Codex-context POST /responses with Bearer API key.
 * "anthropic" → Anthropic Messages API POST /messages.
 * "gemini" → Gemini streamGenerateContent API.
 */
export const API_KEY_WIRES = ["chat", "responses", "codex-responses", "anthropic", "gemini"] as const;
export type ApiKeyWire = typeof API_KEY_WIRES[number];

export interface ApiKeyEntry {
  id: string;
  provider: ApiKeyProvider;
  model: string;
  apiKey: string;
  baseUrl: string;
  projectId?: string;
  label: string | null;
  email?: string | null;
  planType?: string | null;
  capabilities: ApiKeyCapability[];
  wire: ApiKeyWire;
  proxyId?: string | null;
  status: ApiKeyStatus;
  addedAt: string;
  lastUsedAt: string | null;
  requestCount?: number;
  requestTokens?: number;
  imageRequestCount?: number;
  usageWindowStartedAt?: string;
  windowRequestCount?: number;
  windowRequestTokens?: number;
  windowImageRequestCount?: number;
}

export type PersistedApiKeyEntry = Omit<ApiKeyEntry, "capabilities" | "wire"> & {
  capabilities?: ApiKeyCapability[];
  wire?: ApiKeyWire;
};

interface ApiKeysFile {
  keys: PersistedApiKeyEntry[];
}

export interface ApiKeyPersistence {
  load(): PersistedApiKeyEntry[];
  save(keys: ApiKeyEntry[]): void;
}

// ── Persistence ────────────────────────────────────────────────────

function getApiKeysFile(): string {
  return resolve(getDataDir(), "api-keys.json");
}

export function createFsApiKeyPersistence(): ApiKeyPersistence {
  return {
    load(): PersistedApiKeyEntry[] {
      try {
        const file = getApiKeysFile();
        if (!existsSync(file)) return [];
        const raw = readFileSync(file, "utf-8");
        const data = JSON.parse(raw) as ApiKeysFile;
        return Array.isArray(data.keys) ? data.keys : [];
      } catch {
        return [];
      }
    },
    save(keys: ApiKeyEntry[]): void {
      try {
        const file = getApiKeysFile();
        const dir = dirname(file);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const data: ApiKeysFile = { keys };
        const tmp = file + ".tmp";
        writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
        renameSync(tmp, file);
      } catch (err) {
        console.error("[ApiKeyPool] Failed to persist:", err instanceof Error ? err.message : err);
      }
    },
  };
}

// ── Pool ───────────────────────────────────────────────────────────

export class ApiKeyPool {
  private entries: ApiKeyEntry[];
  private persistence: ApiKeyPersistence;

  constructor(persistence?: ApiKeyPersistence) {
    this.persistence = persistence ?? createFsApiKeyPersistence();
    this.entries = this.persistence.load().map(normalizeEntry);
  }

  // ── Query ──────────────────────────────────────────────────────

  getAll(): ApiKeyEntry[] {
    let changed = false;
    const now = new Date();
    for (const entry of this.entries) {
      if (entry.provider !== "antigravity") continue;
      const previous = entry.usageWindowStartedAt;
      this.ensureUsageWindow(entry, now);
      if (entry.usageWindowStartedAt !== previous) changed = true;
    }
    if (changed) this.persist();
    return [...this.entries];
  }

  getEntry(id: string): ApiKeyEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  /** Get all active entries for a given model (exact match). */
  getByModel(model: string): ApiKeyEntry[] {
    return this.getByModelAndCapability(model, "chat");
  }

  /** Get all active entries for a given model and declared capability. */
  getByModelAndCapability(model: string, capability: ApiKeyCapability): ApiKeyEntry[] {
    return this.entries.filter((e) =>
      e.model === model &&
      e.status === "active" &&
      e.capabilities.includes(capability),
    );
  }

  /** Pick and mark the least recently used active entry for a model/capability. */
  acquireByModelAndCapability(model: string, capability: ApiKeyCapability): ApiKeyEntry | undefined {
    const entries = this.getByModelAndCapability(model, capability);
    if (entries.length === 0) return undefined;
    const entry = pickLeastRecentlyUsed(entries);
    this.markUsed(entry.id);
    return entry;
  }

  /** Get all active entries for a given provider. */
  getByProvider(provider: ApiKeyProvider): ApiKeyEntry[] {
    return this.entries.filter((e) => e.provider === provider && e.status === "active");
  }

  /** Get unique active model IDs from runtime-managed API keys. */
  getActiveModels(): string[] {
    return [...new Set(this.entries.filter((e) => e.status === "active").map((e) =>
      e.provider === "antigravity" ? `antigravity:${e.model}` : e.model,
    ))];
  }

  /** Returns true if any active entry matches the given model ID. */
  hasActiveModel(modelId: string): boolean {
    return this.entries.some((e) => e.status === "active" && (
      e.model === modelId || (e.provider === "antigravity" && `antigravity:${e.model}` === modelId)
    ));
  }

  // ── Mutations ──────────────────────────────────────────────────

  add(input: {
    provider: ApiKeyProvider;
    model: string;
    apiKey: string;
    baseUrl?: string;
    projectId?: string;
    label?: string | null;
    email?: string | null;
    planType?: string | null;
    capabilities?: ApiKeyCapability[];
    wire?: ApiKeyWire;
    proxyId?: string | null;
  }): ApiKeyEntry {
    const baseUrl = isBuiltinProvider(input.provider)
      ? PROVIDER_CATALOG[input.provider].defaultBaseUrl
      : input.baseUrl ?? "";

    const entry: ApiKeyEntry = {
      id: randomBytes(8).toString("hex"),
      provider: input.provider,
      model: input.model,
      apiKey: input.apiKey,
      baseUrl,
      ...(input.provider === "antigravity" && input.projectId?.trim() ? { projectId: input.projectId.trim() } : {}),
      label: input.label ?? null,
      proxyId: input.proxyId ?? null,
      ...(input.provider === "antigravity" && input.email?.trim() ? { email: input.email.trim() } : {}),
      ...(input.provider === "antigravity" && input.planType?.trim() ? { planType: input.planType.trim() } : {}),
      capabilities: input.provider === "antigravity" ? ["chat"] : normalizeCapabilities(input.capabilities),
      wire: normalizeWireForProvider(input.provider, input.wire),
      status: "active",
      addedAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    this.entries.push(entry);
    this.persist();
    return entry;
  }

  remove(id: string): boolean {
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx === -1) return false;
    this.entries.splice(idx, 1);
    this.persist();
    return true;
  }

  removeAntigravityAccount(id: string): boolean {
    const target = this.entries.find((entry) => entry.id === id && entry.provider === "antigravity");
    if (!target) return false;
    this.entries = this.entries.filter((entry) => entry.provider !== "antigravity" || entry.apiKey !== target.apiKey);
    this.persist();
    return true;
  }

  setAntigravityAccountStatus(id: string, status: ApiKeyStatus): boolean {
    const target = this.entries.find((entry) => entry.id === id && entry.provider === "antigravity");
    if (!target) return false;
    for (const entry of this.entries) {
      if (entry.provider === "antigravity" && entry.apiKey === target.apiKey) entry.status = status;
    }
    this.persist();
    return true;
  }

  setAntigravityAccountMetadata(id: string, metadata: { email?: string | null; planType?: string | null }): boolean {
    const target = this.entries.find((entry) => entry.id === id && entry.provider === "antigravity");
    if (!target) return false;
    for (const entry of this.entries) {
      if (entry.provider !== "antigravity" || entry.apiKey !== target.apiKey) continue;
      if (metadata.email?.trim()) entry.email = metadata.email.trim();
      if (metadata.planType?.trim()) entry.planType = metadata.planType.trim();
    }
    this.persist();
    return true;
  }

  setLabel(id: string, label: string | null): boolean {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return false;
    entry.label = label;
    this.persist();
    return true;
  }

  setStatus(id: string, status: ApiKeyStatus): boolean {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return false;
    entry.status = status;
    this.persist();
    return true;
  }

  setProxy(id: string, proxyId: string | null): boolean {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return false;
    entry.proxyId = proxyId;
    this.persist();
    return true;
  }

  markUsed(id: string): void {
    const entry = this.entries.find((e) => e.id === id);
    if (entry) {
      const now = new Date();
      this.ensureUsageWindow(entry, now);
      entry.lastUsedAt = now.toISOString();
      entry.requestCount = (entry.requestCount ?? 0) + 1;
      entry.windowRequestCount = (entry.windowRequestCount ?? 0) + 1;
      this.persist();
    }
  }

  recordUsage(id: string, usage: { input_tokens?: number; output_tokens?: number }, imageRequest = false): void {
    const entry = this.entries.find((candidate) => candidate.id === id && candidate.provider === "antigravity");
    if (!entry) return;
    this.ensureUsageWindow(entry, new Date());
    const tokens = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
    entry.requestTokens = (entry.requestTokens ?? 0) + tokens;
    entry.windowRequestTokens = (entry.windowRequestTokens ?? 0) + tokens;
    if (imageRequest) {
      entry.imageRequestCount = (entry.imageRequestCount ?? 0) + 1;
      entry.windowImageRequestCount = (entry.windowImageRequestCount ?? 0) + 1;
    }
    this.persist();
  }

  private ensureUsageWindow(entry: ApiKeyEntry, now: Date): void {
    const startedAt = entry.usageWindowStartedAt ? Date.parse(entry.usageWindowStartedAt) : NaN;
    if (Number.isFinite(startedAt) && now.getTime() - startedAt < ANTIGRAVITY_USAGE_WINDOW_MS) return;
    entry.usageWindowStartedAt = now.toISOString();
    entry.windowRequestCount = 0;
    entry.windowRequestTokens = 0;
    entry.windowImageRequestCount = 0;
  }

  /** Bulk import — returns counts. */
  importMany(items: Array<{
    provider: ApiKeyProvider;
    model: string;
    apiKey: string;
    baseUrl?: string;
    projectId?: string;
    label?: string | null;
    email?: string | null;
    planType?: string | null;
    capabilities?: ApiKeyCapability[];
    wire?: ApiKeyWire;
    proxyId?: string | null;
  }>): { added: number; failed: number; errors: string[] } {
    let added = 0;
    const errors: string[] = [];

    for (const item of items) {
      try {
        this.add(item);
        added++;
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }

    return { added, failed: errors.length, errors };
  }

  /** Export all entries (masks API keys by default). */
  exportAll(unmask = false): ApiKeyEntry[] {
    return this.entries.map((e) => ({
      ...e,
      apiKey: unmask ? e.apiKey : maskKey(e.apiKey),
    }));
  }

  /** Export for re-import (full keys). */
  exportForReimport(): Array<{
    provider: ApiKeyProvider;
    model: string;
    apiKey: string;
    baseUrl?: string;
    projectId?: string;
    label: string | null;
    capabilities: ApiKeyCapability[];
    wire: ApiKeyWire;
    proxyId?: string | null;
  }> {
    return this.entries.map((e) => ({
      provider: e.provider,
      model: e.model,
      apiKey: e.apiKey,
      ...(e.provider === "custom" ? { baseUrl: e.baseUrl } : {}),
      ...(e.provider === "antigravity" && e.projectId ? { projectId: e.projectId } : {}),
      ...(e.proxyId ? { proxyId: e.proxyId } : {}),
      label: e.label,
      capabilities: e.capabilities,
      wire: e.wire,
    }));
  }

  persistNow(): void {
    this.persist();
  }

  // ── Internal ───────────────────────────────────────────────────

  private persist(): void {
    this.persistence.save(this.entries);
  }
}

function maskKey(key: string): string {
  if (key.length <= 8) return "****";
  return key.slice(0, 4) + "****" + key.slice(-4);
}

function isApiKeyCapability(value: unknown): value is ApiKeyCapability {
  return value === "chat" || value === "embeddings";
}

function normalizeCapabilities(value: unknown): ApiKeyCapability[] {
  if (!Array.isArray(value)) return ["chat"];
  const capabilities = value.filter(isApiKeyCapability);
  const deduped = [...new Set(capabilities)];
  return deduped.length > 0 ? deduped : ["chat"];
}

function isApiKeyWire(value: unknown): value is ApiKeyWire {
  return value === "chat"
    || value === "responses"
    || value === "codex-responses"
    || value === "anthropic"
    || value === "gemini";
}

function normalizeWire(value: unknown): ApiKeyWire {
  return isApiKeyWire(value) ? value : "chat";
}

export function normalizeWireForProvider(provider: ApiKeyProvider, value: unknown): ApiKeyWire {
  const wire = normalizeWire(value);
  if (provider === "custom") return wire;
  if (provider === "openai" || provider === "openrouter") {
    return wire === "responses" ? "responses" : "chat";
  }
  if (provider === "anthropic") return "anthropic";
  if (provider === "gemini") return "gemini";
  if (provider === "antigravity") return "gemini";
  return "chat";
}

function normalizeEntry(entry: PersistedApiKeyEntry): ApiKeyEntry {
  const baseUrl = isBuiltinProvider(entry.provider)
    ? PROVIDER_CATALOG[entry.provider].defaultBaseUrl
    : entry.baseUrl;
  return {
    ...entry,
    baseUrl,
    capabilities: normalizeCapabilities(entry.capabilities),
    wire: normalizeWireForProvider(entry.provider, entry.wire),
  };
}

function pickLeastRecentlyUsed(entries: ApiKeyEntry[]): ApiKeyEntry {
  let best = entries[0];
  for (let i = 1; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry.lastUsedAt) return entry;
    if (!best.lastUsedAt || entry.lastUsedAt < best.lastUsedAt) best = entry;
  }
  return best;
}
