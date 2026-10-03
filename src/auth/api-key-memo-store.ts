/**
 * ApiKeyMemoStore — server-side "API key memo" persistence.
 *
 * A memo is a convenience template for adding keys: provider type, base URL,
 * wire, API key, capabilities, and a snapshot of the provider's model list.
 * Memos never affect routing; pool entries keep their own key snapshot after
 * being added. The generator only appears for (provider, baseUrl, wire,
 * apiKey, capabilities) signatures that no memo covers yet.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { randomBytes } from "crypto";
import { getDataDir } from "../paths.js";
import { normalizeWireForProvider } from "./api-key-pool.js";
import type { ApiKeyCapability, ApiKeyWire } from "./api-key-pool.js";
import type { MemoProvider, CatalogModel } from "./api-key-catalog.js";

export interface ApiKeyMemo {
  id: string;
  name: string;
  provider: MemoProvider;
  baseUrl: string;
  wire: ApiKeyWire;
  apiKey: string;
  capabilities: ApiKeyCapability[];
  models: CatalogModel[];
  modelsFetchedAt: string | null;
  createdAt: string;
}

interface ApiKeyMemosFile {
  memos: ApiKeyMemo[];
}

export interface ApiKeyMemoPersistence {
  load(): ApiKeyMemosFile;
  save(memos: ApiKeyMemo[]): void;
}

/** Fields a memo adds on top of its identity signature. */
export type ApiKeyMemoInput = Pick<ApiKeyMemo, "provider" | "baseUrl" | "wire" | "apiKey"> & {
  name?: string;
  capabilities?: ApiKeyCapability[];
};

export function memoSignature(memo: Pick<ApiKeyMemo, "provider" | "baseUrl" | "wire" | "apiKey" | "capabilities">): string {
  return [memo.provider, memo.baseUrl, memo.wire, memo.apiKey, [...memo.capabilities].sort().join("+")].join("::");
}

export function createFsApiKeyMemoPersistence(filePath = resolve(getDataDir(), "api-key-memos.json")): ApiKeyMemoPersistence {
  return {
    load: () => {
      if (!existsSync(filePath)) return { memos: [] };
      try {
        const raw = JSON.parse(readFileSync(filePath, "utf-8")) as Partial<ApiKeyMemosFile>;
        return { memos: Array.isArray(raw.memos) ? raw.memos : [] };
      } catch {
        return { memos: [] };
      }
    },
    save: (memos) => {
      mkdirSync(dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify({ memos }, null, 2), "utf-8");
      renameSync(tmp, filePath);
    },
  };
}

const DEFAULT_CAPABILITIES: ApiKeyCapability[] = ["chat"];

export class ApiKeyMemoStore {
  private readonly persistence: ApiKeyMemoPersistence;
  private memos: ApiKeyMemo[];

  constructor(persistence?: ApiKeyMemoPersistence) {
    this.persistence = persistence ?? createFsApiKeyMemoPersistence();
    this.memos = this.persistence.load().memos.filter(isValidMemo);
  }

  list(): ApiKeyMemo[] {
    return this.memos.map((memo) => ({ ...memo }));
  }

  get(id: string): ApiKeyMemo | undefined {
    const memo = this.memos.find((m) => m.id === id);
    return memo ? { ...memo } : undefined;
  }

  /** Create a memo; a signature-equivalent existing memo is returned instead. */
  create(input: ApiKeyMemoInput): ApiKeyMemo {
    const normalized = {
      provider: input.provider,
      baseUrl: input.baseUrl,
      wire: normalizeWireForProvider(input.provider, input.wire),
      apiKey: input.apiKey,
      capabilities: normalizeCapabilities(input.capabilities),
    };
    const existing = this.memos.find((memo) => memoSignature(memo) === memoSignature(normalized));
    if (existing) return { ...existing };
    const now = new Date().toISOString();
    const memo: ApiKeyMemo = {
      id: randomBytes(8).toString("hex"),
      name: input.name?.trim() || defaultMemoName(input.baseUrl),
      ...normalized,
      models: [],
      modelsFetchedAt: null,
      createdAt: now,
    };
    this.memos.push(memo);
    this.persist();
    return { ...memo };
  }

  update(id: string, input: Partial<Pick<ApiKeyMemo, "name" | "apiKey">>): ApiKeyMemo | undefined {
    const memo = this.memos.find((m) => m.id === id);
    if (!memo) return undefined;
    if (input.name !== undefined) memo.name = input.name.trim() || memo.name;
    if (input.apiKey !== undefined && input.apiKey.trim() && input.apiKey.trim() !== memo.apiKey) {
      memo.apiKey = input.apiKey.trim();
      memo.models = [];
      memo.modelsFetchedAt = null;
    }
    this.persist();
    return { ...memo };
  }

  remove(id: string): boolean {
    const idx = this.memos.findIndex((m) => m.id === id);
    if (idx === -1) return false;
    this.memos.splice(idx, 1);
    this.persist();
    return true;
  }

  /** Replace the model snapshot after a successful provider fetch. */
  setModels(id: string, models: CatalogModel[], fetchedAt: string): ApiKeyMemo | undefined {
    const memo = this.memos.find((m) => m.id === id);
    if (!memo) return undefined;
    memo.models = models;
    memo.modelsFetchedAt = fetchedAt;
    this.persist();
    return { ...memo };
  }

  /** True when some memo already covers this signature — the generator hides. */
  isCovered(input: Pick<ApiKeyMemo, "provider" | "baseUrl" | "wire" | "apiKey" | "capabilities">): boolean {
    return this.memos.some((memo) => memoSignature(memo) === memoSignature(input));
  }

  /**
   * One-click migration: group pool entries by (provider, baseUrl, wire, key,
   * capabilities) and create a memo per group. Returns newly created memos.
   */
  generateFromEntries(entries: Array<Pick<ApiKeyMemo, "provider" | "baseUrl" | "wire" | "apiKey" | "capabilities"> & { model?: string }>): {
    created: ApiKeyMemo[];
    skipped: number;
  } {
    const groups = new Map<string, ApiKeyMemoInput>();
    let skipped = 0;
    for (const entry of entries) {
      if (!entry.apiKey || !entry.baseUrl) continue;
      const signature = memoSignature(entry);
      if (!groups.has(signature)) {
        groups.set(signature, {
          provider: entry.provider,
          baseUrl: entry.baseUrl,
          wire: entry.wire,
          apiKey: entry.apiKey,
          capabilities: entry.capabilities,
        });
      }
    }
    const created: ApiKeyMemo[] = [];
    for (const input of groups.values()) {
      const before = this.memos.length;
      const memo = this.create(input);
      if (this.memos.length > before) created.push(memo);
      else skipped++;
    }
    return { created, skipped };
  }

  private persist(): void {
    this.persistence.save(this.memos);
  }
}

function isValidMemo(value: unknown): value is ApiKeyMemo {
  return Boolean(value)
    && typeof value === "object"
    && typeof (value as ApiKeyMemo).id === "string"
    && typeof (value as ApiKeyMemo).apiKey === "string"
    && typeof (value as ApiKeyMemo).baseUrl === "string";
}

function defaultMemoName(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return baseUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "") || "memo";
  }
}

function isApiKeyCapability(value: unknown): value is ApiKeyCapability {
  return value === "chat" || value === "embeddings";
}

function normalizeCapabilities(value: unknown): ApiKeyCapability[] {
  if (!Array.isArray(value)) return DEFAULT_CAPABILITIES;
  const deduped = [...new Set(value.filter(isApiKeyCapability))];
  return deduped.length > 0 ? deduped : DEFAULT_CAPABILITIES;
}
