/**
 * Local uncaught-error log.
 *
 * Appends sanitized error records to `data/error-log.jsonl`, rotating
 * at a configurable byte cap (single backup file, `error-log.1.jsonl`).
 * A sidecar `error-log.cursor` tracks the last "seen" timestamp so the
 * dashboard can surface an unread count.
 *
 * No-op when `config.observability.local_error_log` is false.
 *
 * Design notes:
 * - Reads `getConfig()` and `getDataDir()` on each call so callers can
 *   change paths / toggle the feature at runtime without re-importing.
 * - Append uses `appendFileSync` (single JSON line is smaller than the
 *   pipe-buffer atomic-write threshold, so concurrent writers can't tear).
 * - Rotation checks current size BEFORE appending. The new entry always
 *   ends up in the post-rotation `error-log.jsonl`, never split across
 *   the boundary.
 * - All `context` values pass through `redactJson` to scrub auth tokens,
 *   cookies, OAuth state, etc., before they hit disk.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "fs";
import { resolve } from "path";
import { getConfig } from "../config.js";
import { getDataDir } from "../paths.js";
import { redactJson } from "./redact.js";

export type ErrorSource = "main" | "renderer" | "server" | "external";

export interface ErrorLogEntry {
  ts: string;
  version: string;
  platform: string;
  source: ErrorSource;
  error: { name: string; message: string; stack?: string };
  context?: Record<string, unknown>;
}

export interface ErrorGroup {
  signature: string;
  name: string;
  message: string;
  count: number;
  first_seen: string;
  last_seen: string;
  source: ErrorSource;
  sample_stack?: string;
  sample_context?: Record<string, unknown>;
}

export interface AppendInput {
  source: ErrorSource;
  error: { name: string; message: string; stack?: string };
  context?: Record<string, unknown>;
}

const LOG_FILE = "error-log.jsonl";
const BACKUP_FILE = "error-log.1.jsonl";
const CURSOR_FILE = "error-log.cursor";
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

interface ObservabilityConfig {
  local_error_log: boolean;
  max_log_bytes: number;
}

function readObservabilityConfig(): ObservabilityConfig {
  const cfg = getConfig() as { observability?: Partial<ObservabilityConfig> };
  return {
    local_error_log: cfg.observability?.local_error_log ?? true,
    max_log_bytes: cfg.observability?.max_log_bytes ?? DEFAULT_MAX_BYTES,
  };
}

function readAppVersion(): string {
  try {
    const cfg = getConfig() as { client?: { app_version?: string } };
    return cfg.client?.app_version ?? "unknown";
  } catch {
    // Config may not be loaded yet during early boot, accounts quarantine,
    // or unit-test paths that exercise log helpers without booting the server.
    // Keep logging best-effort so those events still reach error-log.jsonl.
    return "unknown";
  }
}

function ensureDataDir(): string {
  const dir = getDataDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function logPath(): string {
  return resolve(ensureDataDir(), LOG_FILE);
}

function backupPath(): string {
  return resolve(ensureDataDir(), BACKUP_FILE);
}

function cursorPath(): string {
  return resolve(ensureDataDir(), CURSOR_FILE);
}

/** Rotate `error-log.jsonl` → `error-log.1.jsonl` if current size exceeds the cap. */
function rotateIfNeeded(maxBytes: number): void {
  const current = logPath();
  if (!existsSync(current)) return;
  const size = statSync(current).size;
  if (size <= maxBytes) return;
  // renameSync overwrites the destination on POSIX; on Windows the
  // backup is removed first because rename-onto-existing fails there.
  const backup = backupPath();
  if (existsSync(backup) && process.platform === "win32") {
    try {
      writeFileSync(backup, "");
    } catch {
      /* fall through; renameSync will surface the real error */
    }
  }
  renameSync(current, backup);
}

/**
 * Append an error record to the log.
 * Silently no-op when local error logging is disabled or when the
 * write itself fails (we never want logging to break the caller).
 */
export function appendErrorLog(input: AppendInput): void {
  // Under Vitest, never touch the real data dir. Integration tests that
  // pass through `recordStreamCloseEvent` (proxy-handler / response-processor
  // paths) don't always mock `@src/paths.js`, and we don't want a stray
  // `npm test` to write into the developer's `data/error-log.jsonl`.
  // Test files that intentionally exercise the writer (e.g. `error-log.test.ts`,
  // `stream-close-event.test.ts`) override this via the `__forceAppendInTests`
  // hatch below.
  if (process.env.VITEST && !process.env.VITEST_FORCE_APPEND_ERROR_LOG) return;

  let cfg: ObservabilityConfig;
  try {
    cfg = readObservabilityConfig();
  } catch {
    // Config not yet loaded (early startup crash). Use defaults so we
    // still capture the error rather than silently dropping it.
    cfg = { local_error_log: true, max_log_bytes: DEFAULT_MAX_BYTES };
  }
  if (!cfg.local_error_log) return;

  const sanitizedContext =
    input.context !== undefined
      ? (redactJson(input.context) as Record<string, unknown>)
      : undefined;

  const entry: ErrorLogEntry = {
    ts: new Date().toISOString(),
    version: readAppVersion(),
    platform: process.platform,
    source: input.source,
    error: {
      name: input.error.name,
      message: input.error.message,
      stack: input.error.stack,
    },
    ...(sanitizedContext !== undefined ? { context: sanitizedContext } : {}),
  };

  try {
    rotateIfNeeded(cfg.max_log_bytes);
    appendFileSync(logPath(), JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // Logging failures must never throw. Drop the entry.
  }
}

function readJsonlFile(path: string): ErrorLogEntry[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  const out: ErrorLogEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as ErrorLogEntry);
    } catch {
      // Skip corrupted lines silently.
    }
  }
  return out;
}

/**
 * Read entries from current + backup files, newest first.
 * `limit`, when given, caps the number of returned entries.
 */
export function readErrorLog(limit?: number): ErrorLogEntry[] {
  // Backup is older; current is newer. Concatenate then reverse so
  // the newest entries appear first.
  const oldest = readJsonlFile(backupPath());
  const newest = readJsonlFile(logPath());
  const combined = [...oldest, ...newest];
  combined.reverse();
  if (limit !== undefined) return combined.slice(0, limit);
  return combined;
}

function firstStackFrame(stack: string | undefined): string {
  if (!stack) return "";
  for (const line of stack.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

/**
 * Group entries by signature `name + first non-empty stack frame`.
 * Returned groups are ordered by `last_seen` descending (newest first).
 */
export function groupErrorLog(entries: ErrorLogEntry[]): ErrorGroup[] {
  const groups = new Map<string, ErrorGroup>();
  for (const e of entries) {
    const sig = `${e.error.name}|${firstStackFrame(e.error.stack)}`;
    const existing = groups.get(sig);
    if (existing) {
      existing.count += 1;
      if (e.ts > existing.last_seen) {
        existing.last_seen = e.ts;
        existing.message = e.error.message;
        existing.source = e.source;
        existing.sample_stack = e.error.stack;
        existing.sample_context = e.context;
      }
      if (e.ts < existing.first_seen) existing.first_seen = e.ts;
    } else {
      groups.set(sig, {
        signature: sig,
        name: e.error.name,
        message: e.error.message,
        count: 1,
        first_seen: e.ts,
        last_seen: e.ts,
        source: e.source,
        sample_stack: e.error.stack,
        sample_context: e.context,
      });
    }
  }
  return Array.from(groups.values()).sort((a, b) =>
    a.last_seen < b.last_seen ? 1 : a.last_seen > b.last_seen ? -1 : 0,
  );
}

/** Last-read timestamp from the cursor file; null if no cursor exists. */
export function getReadCursor(): string | null {
  const path = cursorPath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8").trim();
    return raw || null;
  } catch {
    return null;
  }
}

/** Persist the read cursor (overwrites previous value). */
export function setReadCursor(ts: string): void {
  try {
    writeFileSync(cursorPath(), ts, "utf-8");
  } catch {
    // Cursor failures are non-critical — the user may briefly see a
    // stale unread count but no data is lost.
  }
}

/**
 * Count entries strictly newer than the read cursor.
 * If no cursor exists, every entry is unread.
 * Callers can pass a pre-fetched entry list to avoid duplicate reads.
 */
export function getUnreadCount(entries?: ErrorLogEntry[]): number {
  const cursor = getReadCursor();
  const list = entries ?? readErrorLog();
  if (cursor === null) return list.length;
  let count = 0;
  for (const e of list) {
    if (e.ts > cursor) count += 1;
  }
  return count;
}

// ── Process-level handlers ──────────────────────────────────────────

function asError(value: unknown): { name: string; message: string; stack?: string } {
  if (value instanceof Error) {
    return { name: value.name || "Error", message: value.message, stack: value.stack };
  }
  if (typeof value === "string") {
    return { name: "Error", message: value };
  }
  try {
    return { name: "Error", message: JSON.stringify(value) };
  } catch {
    return { name: "Error", message: String(value) };
  }
}

/** Convert an `uncaughtException` argument into an error-log entry. */
export function handleUncaughtException(err: unknown, source: ErrorSource = "main"): void {
  appendErrorLog({ source, error: asError(err) });
}

/** Convert an `unhandledRejection` reason into an error-log entry. */
export function handleUnhandledRejection(reason: unknown, source: ErrorSource = "main"): void {
  appendErrorLog({ source, error: asError(reason) });
}

let _handlersInstalled = false;

/**
 * Register process-wide uncaught handlers that funnel into the local
 * error log. Idempotent — safe to call from both Electron main.ts and
 * the CLI startServer() path.
 *
 * Default Node behavior is preserved: `uncaughtException` is logged,
 * then re-thrown (Node will print + exit), so we never silently swallow
 * a fatal crash. `unhandledRejection` is logged but not re-raised
 * because Node's policy on those is configurable and we don't want to
 * second-guess it.
 */
export function installUncaughtErrorHandlers(source: ErrorSource = "main"): void {
  if (_handlersInstalled) return;
  _handlersInstalled = true;
  process.on("uncaughtException", (err) => {
    handleUncaughtException(err, source);
    // Re-throw on next tick so Node's default crash + stderr behavior
    // still kicks in for fatal errors. The async hop ensures our
    // synchronous log write completes first.
    setImmediate(() => {
      throw err;
    });
  });
  process.on("unhandledRejection", (reason) => {
    handleUnhandledRejection(reason, source);
  });
}

/** Test-only — reset the install flag so a follow-up call re-installs. */
export function _resetInstallFlagForTest(): void {
  _handlersInstalled = false;
}
