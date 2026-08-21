import { randomUUID } from "crypto";
import { logStore, type LogDirection, type LogRecord } from "./store.js";
import type { LogMetrics } from "./metrics.js";
import type { UsageInfo } from "../translation/codex-event-extractor.js";

export function enqueueLogEntry(entry: {
  requestId: string;
  direction: LogDirection;
  method: string;
  path: string;
  model?: string | null;
  provider?: string | null;
  status?: number | null;
  latencyMs?: number | null;
  stream?: boolean | null;
  error?: string | null;
  request?: unknown;
  response?: unknown;
  ttftMs?: number | null;
  durationMs?: number | null;
  costUsd?: number | null;
  tokensPerSecond?: number | null;
  usage?: UsageInfo | null;
  metrics?: LogMetrics | null;
}): void {
  logStore.enqueue({
    id: randomUUID(),
    ts: new Date().toISOString(),
    ...entry,
  });
}

export function updateLogEntry(requestId: string, patch: Partial<LogRecord>): boolean {
  return logStore.updateByRequestId(requestId, patch);
}
