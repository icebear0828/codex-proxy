import type {
  CodexInputItem,
  CodexReasoningItem,
  CodexReasoningStatus,
  CodexReasoningSummaryPart,
  CodexReasoningTextPart,
} from "./codex-types.js";

export type ReasoningReplayItem =
  | CodexReasoningItem
  | Extract<CodexInputItem, { type: "function_call" }>;

export interface ReasoningReplayIdentity {
  entryId: string;
  conversationId: string;
  variantHash: string;
}

export interface ReasoningReplayLookup extends ReasoningReplayIdentity {
  responseId: string;
}

export interface ReasoningReplayRecord extends ReasoningReplayLookup {
  items: readonly unknown[];
}

export interface ReasoningReplayCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  maxEntryBytes?: number;
  maxTotalBytes?: number;
  nowMs?: () => number;
}

interface ReasoningReplayCacheEntry extends ReasoningReplayLookup {
  items: ReasoningReplayItem[];
  byteSize: number;
  createdAt: number;
  sequence: number;
}

export const REASONING_REPLAY_CACHE_TTL_MS = 55 * 60 * 1000;
const DEFAULT_TTL_MS = REASONING_REPLAY_CACHE_TTL_MS;
const DEFAULT_MAX_ENTRIES = 512;
const DEFAULT_MAX_ENTRY_BYTES = 256 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const textEncoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.trim().length > 0 ? value : null;
}

function isReasoningStatus(value: unknown): value is CodexReasoningStatus {
  return value === "in_progress" || value === "completed" || value === "incomplete";
}

function sanitizeSummary(value: unknown): CodexReasoningSummaryPart[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((part): CodexReasoningSummaryPart[] => {
    if (!isRecord(part) || part.type !== "summary_text" || typeof part.text !== "string") {
      return [];
    }
    return [{ type: "summary_text", text: part.text }];
  });
}

function sanitizeContent(value: unknown): CodexReasoningTextPart[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts = value.flatMap((part): CodexReasoningTextPart[] => {
    if (!isRecord(part) || part.type !== "reasoning_text" || typeof part.text !== "string") {
      return [];
    }
    return [{ type: "reasoning_text", text: part.text }];
  });
  return parts.length > 0 ? parts : undefined;
}

function sanitizeReasoningReplayItem(value: unknown): CodexReasoningItem | null {
  if (!isRecord(value) || value.type !== "reasoning") return null;
  const id = nonEmptyString(value.id);
  const summary = sanitizeSummary(value.summary);
  const encryptedContent = nonEmptyString(value.encrypted_content);
  if (!id || summary === undefined || !encryptedContent) return null;

  const item: CodexReasoningItem = {
    type: "reasoning",
    id,
    summary,
    encrypted_content: encryptedContent,
  };
  if (isReasoningStatus(value.status)) item.status = value.status;
  const content = sanitizeContent(value.content);
  if (content) item.content = content;
  return item;
}

function sanitizeFunctionCallReplayItem(
  value: unknown,
): Extract<CodexInputItem, { type: "function_call" }> | null {
  if (!isRecord(value) || value.type !== "function_call") return null;
  const callId = nonEmptyString(value.call_id);
  const name = nonEmptyString(value.name);
  const args = typeof value.arguments === "string" ? value.arguments : null;
  if (!callId || !name || args === null) return null;

  const item: Extract<CodexInputItem, { type: "function_call" }> = {
    type: "function_call",
    call_id: callId,
    name,
    arguments: args,
  };
  const id = nonEmptyString(value.id);
  if (id) item.id = id;
  return item;
}

function replayItemKey(item: ReasoningReplayItem): string {
  if (item.type === "function_call") return `function_call:${item.call_id}`;
  return `reasoning:${item.id ?? item.encrypted_content ?? ""}`;
}

export function sanitizeReasoningReplayItems(items: readonly unknown[]): ReasoningReplayItem[] {
  const seen = new Set<string>();
  const sanitized: ReasoningReplayItem[] = [];
  for (const item of items) {
    const replayItem =
      sanitizeReasoningReplayItem(item) ??
      sanitizeFunctionCallReplayItem(item);
    if (!replayItem) continue;
    const key = replayItemKey(replayItem);
    if (seen.has(key)) continue;
    seen.add(key);
    sanitized.push(replayItem);
  }
  return sanitized;
}

function cloneReplayItem(item: ReasoningReplayItem): ReasoningReplayItem {
  if (item.type === "function_call") {
    return {
      type: "function_call",
      ...(item.id ? { id: item.id } : {}),
      call_id: item.call_id,
      name: item.name,
      arguments: item.arguments,
    };
  }
  return {
    type: "reasoning",
    id: item.id,
    ...(item.status ? { status: item.status } : {}),
    ...(item.encrypted_content ? { encrypted_content: item.encrypted_content } : {}),
    summary: item.summary.map((part) => ({ ...part })),
    ...(item.content ? { content: item.content.map((part) => ({ ...part })) } : {}),
  };
}

function matchesIdentity(
  entry: ReasoningReplayIdentity,
  identity: ReasoningReplayIdentity,
): boolean {
  return entry.entryId === identity.entryId &&
    entry.conversationId === identity.conversationId &&
    entry.variantHash === identity.variantHash;
}

function estimateReplayItemsBytes(items: readonly ReasoningReplayItem[]): number {
  return textEncoder.encode(JSON.stringify(items)).byteLength;
}

export class ReasoningReplayCache {
  private entries = new Map<string, ReasoningReplayCacheEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxEntryBytes: number;
  private readonly maxTotalBytes: number;
  private readonly nowMs: () => number;
  private nextSequence = 0;
  private totalBytes = 0;

  constructor(options: ReasoningReplayCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = Math.max(0, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.maxEntryBytes = Math.max(0, options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES);
    this.maxTotalBytes = Math.max(0, options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES);
    this.nowMs = options.nowMs ?? Date.now;
  }

  record(record: ReasoningReplayRecord): number {
    this.cleanupExpired();
    const items = sanitizeReasoningReplayItems(record.items);
    if (items.length === 0) {
      this.deleteEntry(record.responseId);
      return 0;
    }
    const clonedItems = items.map(cloneReplayItem);
    const byteSize = estimateReplayItemsBytes(clonedItems);
    if (byteSize > this.maxEntryBytes) {
      this.deleteEntry(record.responseId);
      return 0;
    }
    this.deleteEntry(record.responseId);
    this.entries.set(record.responseId, {
      responseId: record.responseId,
      entryId: record.entryId,
      conversationId: record.conversationId,
      variantHash: record.variantHash,
      items: clonedItems,
      byteSize,
      createdAt: this.nowMs(),
      sequence: this.nextSequence++,
    });
    this.totalBytes += byteSize;
    this.evictOverflow();
    return this.entries.has(record.responseId) ? items.length : 0;
  }

  lookup(lookup: ReasoningReplayLookup): ReasoningReplayItem[] {
    this.cleanupExpired();
    const entry = this.entries.get(lookup.responseId);
    if (!entry || !matchesIdentity(entry, lookup)) return [];
    return entry.items.map(cloneReplayItem);
  }

  evictByIdentity(identity: ReasoningReplayIdentity): number {
    let evicted = 0;
    for (const [responseId, entry] of this.entries) {
      if (!matchesIdentity(entry, identity)) continue;
      this.deleteEntry(responseId);
      evicted++;
    }
    return evicted;
  }

  evictByResponseId(responseId: string): boolean {
    return this.deleteEntry(responseId);
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  get size(): number {
    this.cleanupExpired();
    return this.entries.size;
  }

  private cleanupExpired(): void {
    const now = this.nowMs();
    for (const [responseId, entry] of this.entries) {
      if (now - entry.createdAt > this.ttlMs) {
        this.deleteEntry(responseId);
      }
    }
  }

  private evictOverflow(): void {
    while (this.entries.size > this.maxEntries || this.totalBytes > this.maxTotalBytes) {
      let oldestResponseId: string | null = null;
      let oldestCreatedAt = Number.POSITIVE_INFINITY;
      let oldestSequence = Number.POSITIVE_INFINITY;
      for (const [responseId, entry] of this.entries) {
        if (
          entry.createdAt < oldestCreatedAt ||
          (entry.createdAt === oldestCreatedAt && entry.sequence < oldestSequence)
        ) {
          oldestResponseId = responseId;
          oldestCreatedAt = entry.createdAt;
          oldestSequence = entry.sequence;
        }
      }
      if (!oldestResponseId) return;
      this.deleteEntry(oldestResponseId);
    }
  }

  private deleteEntry(responseId: string): boolean {
    const entry = this.entries.get(responseId);
    if (!entry) return false;
    this.entries.delete(responseId);
    this.totalBytes = Math.max(0, this.totalBytes - entry.byteSize);
    return true;
  }
}

function stringContainsInvalidEncryptedContent(value: string): boolean {
  const lower = value.toLowerCase();
  return lower.includes("invalid_encrypted_content") ||
    (lower.includes("invalid") && lower.includes("encrypted") && lower.includes("content"));
}

export function containsInvalidEncryptedContentSignal(value: unknown): boolean {
  if (value instanceof Error) {
    return stringContainsInvalidEncryptedContent(value.message) ||
      stringContainsInvalidEncryptedContent(value.name);
  }

  const visit = (node: unknown, depth: number): boolean => {
    if (depth > 5) return false;
    if (typeof node === "string") return stringContainsInvalidEncryptedContent(node);
    if (Array.isArray(node)) return node.some((item) => visit(item, depth + 1));
    if (!isRecord(node)) return false;
    for (const [key, child] of Object.entries(node)) {
      if (stringContainsInvalidEncryptedContent(key) || visit(child, depth + 1)) {
        return true;
      }
    }
    return false;
  };

  return visit(value, 0);
}

let singleton: ReasoningReplayCache | null = null;

export function getReasoningReplayCache(): ReasoningReplayCache {
  if (!singleton) singleton = new ReasoningReplayCache();
  return singleton;
}

export function resetReasoningReplayCacheForTests(): void {
  singleton = new ReasoningReplayCache();
}
