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

export interface ApiKeyEntry {
  id: string;
  provider: ApiKeyProvider;
  model: string;
  apiKey: string;
  baseUrl: string;
  label: string | null;
  status: ApiKeyStatus;
  addedAt: string;
  lastUsedAt: string | null;
}

interface ApiKeysFile {
  keys: ApiKeyEntry[];
}

export interface ApiKeyPersistence {
  load(): ApiKeyEntry[];
  save(keys: ApiKeyEntry[]): void;
}

// ── Persistence ────────────────────────────────────────────────────

function getApiKeysFile(): string {
  return resolve(getDataDir(), "api-keys.json");
}

export function createFsApiKeyPersistence(): ApiKeyPersistence {
  return {
    load(): ApiKeyEntry[] {
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
    this.entries = this.persistence.load();
  }

  // ── Query ──────────────────────────────────────────────────────

  getAll(): ApiKeyEntry[] {
    return [...this.entries];
  }

  getEntry(id: string): ApiKeyEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  /** Get all active entries for a given model (exact match). */
  getByModel(model: string): ApiKeyEntry[] {
    return this.entries.filter((e) => e.model === model && e.status === "active");
  }

  /** Get all active entries for a given provider. */
  getByProvider(provider: ApiKeyProvider): ApiKeyEntry[] {
    return this.entries.filter((e) => e.provider === provider && e.status === "active");
  }

  // ── Mutations ──────────────────────────────────────────────────

  add(input: {
    provider: ApiKeyProvider;
    model: string;
    apiKey: string;
    baseUrl?: string;
    label?: string | null;
  }): ApiKeyEntry {
    const baseUrl = input.baseUrl
      ?? (isBuiltinProvider(input.provider) ? PROVIDER_CATALOG[input.provider].defaultBaseUrl : "");

    const entry: ApiKeyEntry = {
      id: randomBytes(8).toString("hex"),
      provider: input.provider,
      model: input.model,
      apiKey: input.apiKey,
      baseUrl,
      label: input.label ?? null,
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

  markUsed(id: string): void {
    const entry = this.entries.find((e) => e.id === id);
    if (entry) {
      entry.lastUsedAt = new Date().toISOString();
      // Defer persist — lastUsedAt is non-critical
    }
  }

  /** Bulk import — returns counts. */
  importMany(items: Array<{
    provider: ApiKeyProvider;
    model: string;
    apiKey: string;
    baseUrl?: string;
    label?: string | null;
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
    baseUrl: string;
    label: string | null;
  }> {
    return this.entries.map((e) => ({
      provider: e.provider,
      model: e.model,
      apiKey: e.apiKey,
      baseUrl: e.baseUrl,
      label: e.label,
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
