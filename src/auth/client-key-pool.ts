import { randomBytes } from "crypto";
import { getConfig } from "../config.js";
import { ClientKeyPersistence } from "./client-key-persistence.js";
import {
  type ClientKeyEntry,
  type ClientKeyPublicSummary,
  type CreateClientKeyInput,
  type UpdateClientKeyInput,
  type ClientKeyAccessValidation,
} from "./client-key-types.js";
import { calculateUsageCostUsd, loadPricingCatalog, type PricingCatalog } from "./usage-pricing.js";

function generateClientKey(): string {
  return `sk-proxy-${randomBytes(16).toString("hex")}`;
}

export function maskClientKey(key: string): string {
  if (key.length <= 12) return key.slice(0, 4) + "•".repeat(6);
  return `${key.slice(0, 9)}••••••••${key.slice(-4)}`;
}

export class ClientKeyPool {
  private keys: Map<string, ClientKeyEntry> = new Map();
  private keyToId: Map<string, string> = new Map();
  private activeConcurrency: Map<string, number> = new Map();
  private persistence: ClientKeyPersistence;
  private getMasterKey: () => string | null;

  constructor(
    persistence?: ClientKeyPersistence,
    getMasterKey?: () => string | null,
  ) {
    this.persistence = persistence ?? new ClientKeyPersistence();
    this.getMasterKey = getMasterKey ?? (() => getConfig().server.proxy_api_key ?? null);
    this.reload();
  }

  public reload(): void {
    const list = this.persistence.load();
    this.keys.clear();
    this.keyToId.clear();
    for (const item of list) {
      this.keys.set(item.id, item);
      this.keyToId.set(item.key, item.id);
    }
  }

  public getAll(): ClientKeyEntry[] {
    return Array.from(this.keys.values());
  }

  public getAllPublicSummaries(): ClientKeyPublicSummary[] {
    return this.getAll().map((k) => this.toPublicSummary(k));
  }

  public toPublicSummary(k: ClientKeyEntry): ClientKeyPublicSummary {
    return {
      id: k.id,
      name: k.name,
      key_masked: maskClientKey(k.key),
      status: k.status,
      expires_at: k.expires_at,
      max_budget_usd: k.max_budget_usd,
      used_cost_usd: k.used_cost_usd,
      max_tokens: k.max_tokens,
      used_tokens: k.used_tokens,
      max_concurrency: k.max_concurrency,
      allowed_models: k.allowed_models,
      default_tools: k.default_tools,
      request_count: k.request_count,
      last_used_at: k.last_used_at,
      created_at: k.created_at,
      updated_at: k.updated_at,
    };
  }

  public getById(id: string): ClientKeyEntry | undefined {
    return this.keys.get(id);
  }

  public getByKey(key: string): ClientKeyEntry | undefined {
    const id = this.keyToId.get(key);
    return id ? this.keys.get(id) : undefined;
  }

  public createKey(input: CreateClientKeyInput): ClientKeyEntry {
    const masterKey = this.getMasterKey();
    const finalKey = input.key?.trim() ? input.key.trim() : generateClientKey();

    if (masterKey && finalKey === masterKey) {
      throw new Error("Client key conflicts with master API key");
    }

    if (this.keyToId.has(finalKey)) {
      throw new Error(`Client key '${finalKey}' already exists`);
    }

    const now = new Date().toISOString();
    const id = `ck_${randomBytes(8).toString("hex")}`;
    const entry: ClientKeyEntry = {
      id,
      name: input.name.trim(),
      key: finalKey,
      status: "active",
      expires_at: input.expires_at ?? null,
      max_budget_usd: input.max_budget_usd ?? null,
      used_cost_usd: 0,
      max_tokens: input.max_tokens ?? null,
      used_tokens: 0,
      max_concurrency: input.max_concurrency ?? null,
      allowed_models: input.allowed_models && input.allowed_models.length > 0 ? input.allowed_models : null,
      default_tools: input.default_tools !== undefined ? input.default_tools : null,
      request_count: 0,
      last_used_at: null,
      created_at: now,
      updated_at: now,
    };

    this.keys.set(id, entry);
    this.keyToId.set(finalKey, id);

    try {
      this.persistence.save(this.getAll());
    } catch (err) {
      // rollback on persistence failure
      this.keys.delete(id);
      this.keyToId.delete(finalKey);
      throw err;
    }

    return entry;
  }

  public updateKey(id: string, input: UpdateClientKeyInput): ClientKeyEntry {
    const existing = this.keys.get(id);
    if (!existing) {
      throw new Error(`Client key '${id}' not found`);
    }

    const now = new Date().toISOString();
    const updated: ClientKeyEntry = {
      ...existing,
      name: input.name !== undefined ? input.name.trim() : existing.name,
      status: input.status ?? existing.status,
      expires_at: input.expires_at !== undefined ? input.expires_at : existing.expires_at,
      max_budget_usd: input.max_budget_usd !== undefined ? input.max_budget_usd : existing.max_budget_usd,
      max_tokens: input.max_tokens !== undefined ? input.max_tokens : existing.max_tokens,
      max_concurrency: input.max_concurrency !== undefined ? input.max_concurrency : existing.max_concurrency,
      allowed_models: input.allowed_models !== undefined ? input.allowed_models : existing.allowed_models,
      default_tools: input.default_tools !== undefined ? input.default_tools : existing.default_tools,
      updated_at: now,
    };

    this.keys.set(id, updated);

    try {
      this.persistence.save(this.getAll());
    } catch (err) {
      this.keys.set(id, existing);
      throw err;
    }

    return updated;
  }

  public toggleStatus(id: string): ClientKeyEntry {
    const existing = this.keys.get(id);
    if (!existing) {
      throw new Error(`Client key '${id}' not found`);
    }
    const newStatus = existing.status === "active" ? "disabled" : "active";
    return this.updateKey(id, { status: newStatus });
  }

  public resetUsage(id: string): ClientKeyEntry {
    const existing = this.keys.get(id);
    if (!existing) {
      throw new Error(`Client key '${id}' not found`);
    }
    const now = new Date().toISOString();
    const reset: ClientKeyEntry = {
      ...existing,
      used_cost_usd: 0,
      used_tokens: 0,
      request_count: 0,
      updated_at: now,
    };
    this.keys.set(id, reset);

    try {
      this.persistence.save(this.getAll());
    } catch (err) {
      this.keys.set(id, existing);
      throw err;
    }

    return reset;
  }

  public deleteKey(id: string): boolean {
    const existing = this.keys.get(id);
    if (!existing) return false;

    this.keys.delete(id);
    this.keyToId.delete(existing.key);
    this.activeConcurrency.delete(id);

    try {
      this.persistence.save(this.getAll());
    } catch (err) {
      this.keys.set(id, existing);
      this.keyToId.set(existing.key, id);
      throw err;
    }

    return true;
  }

  public validateAccess(key: string): ClientKeyAccessValidation {
    const masterKey = this.getMasterKey();
    if (masterKey && key === masterKey) {
      return {
        allowed: false,
        reason: "master_key_conflict",
        message: "Client key conflicts with master API key",
        statusCode: 401,
      };
    }

    const entry = this.getByKey(key);
    if (!entry) {
      return {
        allowed: false,
        reason: "key_not_found",
        message: "Invalid proxy API key",
        statusCode: 401,
      };
    }

    if (entry.status !== "active") {
      return {
        allowed: false,
        reason: "key_disabled",
        message: "Client access key has been disabled",
        statusCode: 401,
      };
    }

    if (entry.expires_at) {
      const exp = Date.parse(entry.expires_at);
      if (!Number.isFinite(exp)) {
        // Fail-closed on invalid dates
        return {
          allowed: false,
          reason: "invalid_key_expiration",
          message: "Client key expiration timestamp is invalid",
          statusCode: 401,
        };
      }
      if (exp <= Date.now()) {
        return {
          allowed: false,
          reason: "key_expired",
          message: "Client access key has expired",
          statusCode: 401,
        };
      }
    }

    if (entry.max_budget_usd != null && entry.used_cost_usd >= entry.max_budget_usd) {
      return {
        allowed: false,
        reason: "insufficient_quota",
        message: "Client key budget limit exceeded",
        statusCode: 429,
      };
    }

    if (entry.max_tokens != null && entry.used_tokens >= entry.max_tokens) {
      return {
        allowed: false,
        reason: "insufficient_quota",
        message: "Client key token limit exceeded",
        statusCode: 429,
      };
    }

    return { allowed: true };
  }

  public acquireSlot(id: string): boolean {
    const entry = this.keys.get(id);
    if (!entry) return false;
    if (entry.max_concurrency == null || entry.max_concurrency <= 0) return true;

    const current = this.activeConcurrency.get(id) ?? 0;
    if (current >= entry.max_concurrency) {
      return false;
    }
    this.activeConcurrency.set(id, current + 1);
    return true;
  }

  public releaseSlot(id: string): void {
    const current = this.activeConcurrency.get(id) ?? 0;
    if (current <= 1) {
      this.activeConcurrency.delete(id);
    } else {
      this.activeConcurrency.set(id, current - 1);
    }
  }

  private cachedPricingCatalog: PricingCatalog | null = null;
  private getPricingCatalog(): PricingCatalog {
    if (!this.cachedPricingCatalog) {
      try {
        this.cachedPricingCatalog = loadPricingCatalog();
      } catch {
        this.cachedPricingCatalog = {};
      }
    }
    return this.cachedPricingCatalog;
  }

  public recordUsage(
    id: string,
    model: string,
    usage: { input_tokens?: number; output_tokens?: number; cached_tokens?: number },
    costUsd?: number,
    pricingCatalog?: PricingCatalog,
  ): void {
    const entry = this.keys.get(id);
    if (!entry) return;

    const inTokens = usage.input_tokens ?? 0;
    const outTokens = usage.output_tokens ?? 0;
    const totalTokens = inTokens + outTokens;

    let computedCost = costUsd;
    if (computedCost === undefined) {
      const catalog = pricingCatalog ?? this.getPricingCatalog();
      computedCost = calculateUsageCostUsd(model, {
        input_tokens: inTokens,
        output_tokens: outTokens,
        cached_tokens: usage.cached_tokens ?? 0,
      }, catalog);
    }

    entry.used_cost_usd += computedCost;
    entry.used_tokens += totalTokens;
    entry.request_count += 1;
    entry.last_used_at = new Date().toISOString();
    entry.updated_at = new Date().toISOString();

    try {
      this.persistence.save(this.getAll());
    } catch (err) {
      console.error(`[ClientKeyPool] Failed to persist usage for client key ${id}:`, err);
    }
  }
}
