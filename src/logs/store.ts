import { redactJson } from "./redact.js";
import type { LogMetrics } from "./metrics.js";
import type { UsageInfo } from "../translation/codex-event-extractor.js";

export type LogDirection = "ingress" | "egress";

export interface LogRecord {
  id: string;
  requestId: string;
  direction: LogDirection;
  ts: string;
  method: string;
  path: string;
  model?: string | null;
  provider?: string | null;
  /** Human-readable identifier of the account that actually served this
   *  request (label / email / short entry id). Null for paths with no account
   *  pool (e.g. plain API-key upstreams). */
  account?: string | null;
  /** True when this request was served by a fallback (backup account retry or
   *  fallback upstream apikey) rather than the initially acquired account. */
  fallback?: boolean;
  status?: number | null;
  latencyMs?: number | null;
  stream?: boolean | null;
  sizeBytes?: number | null;
  error?: string | null;
  tags?: string[];
  request?: unknown;
  response?: unknown;
  meta?: Record<string, unknown>;
  ttftMs?: number | null;
  durationMs?: number | null;
  costUsd?: number | null;
  tokensPerSecond?: number | null;
  usage?: UsageInfo | null;
  metrics?: LogMetrics | null;
}

export interface LogState {
  enabled: boolean;
  paused: boolean;
  dropped: number;
  size: number;
  capacity: number;
}

interface LogStateUpdate {
  enabled?: boolean;
  paused?: boolean;
  capacity?: number;
}

export interface LogQuery {
  direction?: LogDirection | "all";
  search?: string | null;
  limit?: number;
  offset?: number;
}

const DEFAULT_CAPACITY = 2000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.trunc(limit)), MAX_LIMIT);
}

function normalizeOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset)) return 0;
  return Math.max(0, Math.trunc(offset));
}

export class LogStore {
  private records: LogRecord[] = [];
  private capacity: number;
  private enabled = true;
  private paused = false;
  private dropped = 0;
  private queue: LogRecord[] = [];
  private flushScheduled = false;

  constructor(capacity = DEFAULT_CAPACITY) {
    this.capacity = capacity;
  }

  getState(): LogState {
    return {
      enabled: this.enabled,
      paused: this.paused,
      dropped: this.dropped,
      size: this.records.length,
      capacity: this.capacity,
    };
  }

  setState(next: LogStateUpdate): LogState {
    if (typeof next.enabled === "boolean") {
      this.enabled = next.enabled;
      if (next.enabled) this.paused = false;
    }
    if (typeof next.paused === "boolean") this.paused = next.paused;
    if (typeof next.capacity === "number" && Number.isFinite(next.capacity)) {
      this.capacity = Math.max(1, Math.trunc(next.capacity));
      this.trimToCapacity();
    }
    return this.getState();
  }

  clear(): void {
    this.records = [];
    this.dropped = 0;
  }

  enqueue(record: LogRecord): void {
    if (!this.enabled || this.paused) return;
    this.queue.push(record);
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => this.flush());
    }
  }

  list(query: LogQuery): { records: LogRecord[]; total: number; offset: number; limit: number } {
    const direction = query.direction ?? "all";
    const search = (query.search ?? "").trim().toLowerCase();
    let results = this.records;

    if (direction !== "all") {
      results = results.filter((r) => r.direction === direction);
    }

    if (search) {
      results = results.filter((r) => {
        const hay = `${r.method} ${r.path} ${r.model ?? ""} ${r.provider ?? ""} ${r.status ?? ""}`.toLowerCase();
        return hay.includes(search);
      });
    }

    const total = results.length;
    const limit = normalizeLimit(query.limit);
    const offset = normalizeOffset(query.offset);
    const newestFirst = [...results].reverse();
    const sliced = newestFirst.slice(offset, offset + limit);

    return { records: sliced, total, offset, limit };
  }

  get(id: string): LogRecord | null {
    return this.records.find((r) => r.id === id) ?? null;
  }

  updateByRequestId(requestId: string, patch: Partial<LogRecord>): boolean {
    if (this.queue.length > 0) {
      this.flush();
    }
    let updated = false;
    for (const record of this.records) {
      if (record.requestId === requestId) {
        updated = true;
        if (patch.status !== undefined) record.status = patch.status;
        if (patch.latencyMs !== undefined) record.latencyMs = patch.latencyMs;
        if (patch.model !== undefined) record.model = patch.model;
        if (patch.account !== undefined) record.account = patch.account;
        if (patch.fallback !== undefined) record.fallback = patch.fallback;
        if (patch.error !== undefined) record.error = patch.error;
        if (patch.ttftMs !== undefined) record.ttftMs = patch.ttftMs;
        if (patch.durationMs !== undefined) record.durationMs = patch.durationMs;
        if (patch.costUsd !== undefined) record.costUsd = patch.costUsd;
        if (patch.tokensPerSecond !== undefined) record.tokensPerSecond = patch.tokensPerSecond;
        if (patch.usage !== undefined) record.usage = patch.usage;
        if (patch.metrics !== undefined) record.metrics = patch.metrics;
        if (patch.response !== undefined) {
          record.response = redactJson(patch.response);
        }
      }
    }
    return updated;
  }

  private flush(): void {
    this.flushScheduled = false;
    if (!this.queue.length) return;

    const batch = this.queue.splice(0, this.queue.length);
    for (const record of batch) {
      const redacted: LogRecord = {
        ...record,
        request: record.request !== undefined ? redactJson(record.request) : undefined,
        response: record.response !== undefined ? redactJson(record.response) : undefined,
      };
      this.records.push(redacted);
    }

    this.trimToCapacity();
  }

  private trimToCapacity(): void {
    if (this.records.length <= this.capacity) return;
    const over = this.records.length - this.capacity;
    this.records.splice(0, over);
    this.dropped += over;
  }
}

export const logStore = new LogStore();
