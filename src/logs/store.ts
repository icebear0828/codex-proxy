import { redactJson } from "./redact.js";

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
  status?: number | null;
  latencyMs?: number | null;
  stream?: boolean | null;
  sizeBytes?: number | null;
  error?: string | null;
  tags?: string[];
  request?: unknown;
  response?: unknown;
  meta?: Record<string, unknown>;
}

export interface LogState {
  enabled: boolean;
  paused: boolean;
  dropped: number;
  size: number;
  capacity: number;
}

export interface LogQuery {
  direction?: LogDirection | "all";
  search?: string | null;
  limit?: number;
  offset?: number;
}

const DEFAULT_CAPACITY = 2000;

export class LogStore {
  private records: LogRecord[] = [];
  private readonly capacity: number;
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

  setState(next: Partial<Pick<LogState, "enabled" | "paused">>): LogState {
    if (typeof next.enabled === "boolean") this.enabled = next.enabled;
    if (typeof next.paused === "boolean") this.paused = next.paused;
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
    const limit = Math.min(Math.max(1, query.limit ?? 50), 200);
    const offset = Math.max(0, query.offset ?? 0);
    const sliced = results.slice(offset, offset + limit);

    return { records: sliced, total, offset, limit };
  }

  get(id: string): LogRecord | null {
    return this.records.find((r) => r.id === id) ?? null;
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

    if (this.records.length > this.capacity) {
      const over = this.records.length - this.capacity;
      this.records.splice(0, over);
      this.dropped += over;
    }
  }
}

export const logStore = new LogStore();
