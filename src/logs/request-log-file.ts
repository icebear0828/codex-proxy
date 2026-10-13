/**
 * On-disk mirror of the in-memory request log.
 *
 * Every accepted LogRecord is appended as a single JSON line to
 * `data/request-log.jsonl`, so debugging never depends on the in-memory
 * store surviving (or on `/admin/logs` being queried before eviction).
 * Rotation mirrors error-log.ts: when the file exceeds a byte cap the
 * current file becomes `request-log.1.jsonl` and a fresh file is started.
 *
 * Writes are best-effort: a disk failure must never break request handling.
 * Under Vitest nothing is written unless VITEST_FORCE_REQUEST_LOG_FILE=1,
 * so unit tests don't pollute the developer's real data dir.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "fs";
import { resolve } from "path";
import { getConfig } from "../config.js";
import { getDataDir } from "../paths.js";
import { redactJson, redactTextValues } from "./redact.js";
import type { LogRecord } from "./store.js";

const LOG_FILE = "request-log.jsonl";
const BACKUP_FILE = "request-log.1.jsonl";
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
/** Records whose serialized body exceeds this are body-truncated before write. */
const MAX_RECORD_BYTES = 256 * 1024;

interface RequestLogConfig {
  enabled: boolean;
  maxBytes: number;
}

function readRequestLogConfig(): RequestLogConfig {
  try {
    const cfg = getConfig() as {
      logs?: { enabled?: boolean };
      observability?: { request_log_file?: boolean; max_log_bytes?: number };
    };
    return {
      enabled: (cfg.logs?.enabled ?? false) && (cfg.observability?.request_log_file ?? true),
      maxBytes: cfg.observability?.max_log_bytes ?? DEFAULT_MAX_BYTES,
    };
  } catch {
    // Fail closed when config is unavailable: logging must not bypass the
    // user's logs.enabled opt-in during early boot or config failures.
    return { enabled: false, maxBytes: DEFAULT_MAX_BYTES };
  }
}

function logPath(): string {
  const dir = getDataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return resolve(dir, LOG_FILE);
}

function backupPath(): string {
  const dir = getDataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return resolve(dir, BACKUP_FILE);
}

function rotateIfNeeded(maxBytes: number): void {
  const current = logPath();
  if (!existsSync(current)) return;
  if (statSync(current).size <= maxBytes) return;
  const backup = backupPath();
  if (process.platform === "win32" && existsSync(backup)) {
    try {
      unlinkSync(backup);
    } catch {
      /* rename will surface the real error */
    }
  }
  try {
    renameSync(current, backup);
  } catch {
    /* best-effort */
  }
}

/** Deep-truncate an arbitrary value so a single log line stays bounded. */
function truncateValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value.length > 4096 ? value.slice(0, 4096) + `…[truncated ${value.length - 4096} chars]` : value;
  }
  if (typeof value !== "object") return value;
  if (depth > 6) return "[truncated:max-depth]";
  if (Array.isArray(value)) {
    const out = value.slice(0, 50).map((v) => truncateValue(v, depth + 1));
    if (value.length > 50) out.push(`[truncated:${value.length - 50} more items]`);
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = truncateValue(v, depth + 1);
  }
  return out;
}

function serializeRecord(record: LogRecord): string {
  let line = JSON.stringify(record);
  if (line.length <= MAX_RECORD_BYTES) return line;
  const slim: LogRecord = {
    ...record,
    error: truncateValue(record.error) as LogRecord["error"],
    request: truncateValue(record.request),
    response: truncateValue(record.response),
    meta: truncateValue(record.meta) as Record<string, unknown> | undefined,
  };
  line = JSON.stringify(slim);
  if (line.length <= MAX_RECORD_BYTES) return line;
  // Still too large — drop bodies entirely but keep the audit fields.
  const minimal: LogRecord = {
    ...slim,
    request: "[omitted:oversized]",
    response: "[omitted:oversized]",
    meta: { truncated: true },
  };
  return JSON.stringify(minimal);
}

/**
 * Append a redacted record to the on-disk request log.
 * No-op when disabled, under Vitest (unless forced), or when writes fail.
 */
export function appendRequestLogRecord(record: LogRecord): void {
  if (process.env.VITEST && !process.env.VITEST_FORCE_REQUEST_LOG_FILE) return;

  const cfg = readRequestLogConfig();
  if (!cfg.enabled) return;

  try {
    const redacted = redactTextValues(redactJson(record)) as LogRecord;
    rotateIfNeeded(cfg.maxBytes);
    appendFileSync(logPath(), serializeRecord(redacted) + "\n", "utf-8");
  } catch {
    // Logging must never throw into request handling.
  }
}

/** Remove both the active and rotated request logs when an operator clears logs. */
export function clearRequestLogFile(): void {
  if (process.env.VITEST && !process.env.VITEST_FORCE_REQUEST_LOG_FILE) return;
  try {
    const dir = getDataDir();
    for (const filename of [LOG_FILE, BACKUP_FILE]) {
      const file = resolve(dir, filename);
      if (existsSync(file)) unlinkSync(file);
    }
  } catch {
    // Log clearing must not make the admin endpoint fail.
  }
}
