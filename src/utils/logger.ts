/**
 * Structured logger — JSON in production, readable in development.
 *
 * Usage:
 *   import { log } from "../utils/logger.js";
 *   log.info("Request received", { method: "POST", path: "/v1/chat/completions" });
 *   log.warn("Stale lock", { entryId: "abc" });
 *   log.error("Curl failed", { code: 1, stderr: "..." });
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const isProduction = process.env.NODE_ENV === "production";
const minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? (isProduction ? "info" : "debug");

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[minLevel];
}

function emit(level: LogLevel, message: string, extra?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;

  if (isProduction) {
    // JSON structured output for container/log aggregator consumption
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      msg: message,
      ...extra,
    };
    const line = JSON.stringify(entry);
    if (level === "error") {
      process.stderr.write(line + "\n");
    } else {
      process.stdout.write(line + "\n");
    }
  } else {
    // Human-readable for development
    const prefix = `[${level.toUpperCase()}]`;
    const parts: unknown[] = [prefix, message];
    if (extra && Object.keys(extra).length > 0) {
      parts.push(extra);
    }
    if (level === "error") {
      console.error(...parts);
    } else if (level === "warn") {
      console.warn(...parts);
    } else {
      console.log(...parts);
    }
  }
}

export const log = {
  debug: (msg: string, extra?: Record<string, unknown>) => emit("debug", msg, extra),
  info: (msg: string, extra?: Record<string, unknown>) => emit("info", msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => emit("warn", msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => emit("error", msg, extra),
};
