import type { Context, Next } from "hono";
import { getConfig } from "../config.js";
import { enqueueLogEntry, updateLogEntry } from "../logs/entry.js";

const KNOWN_LLM_PATHS = [
  /^\/v1\/chat\/completions$/,
  /^\/v1\/messages$/,
  /^\/v1\/responses(?:\/compact)?$/,
  /^\/v1\/models(?:\/.*)?$/,
  /^\/v1beta\/models(?:\/.*)?$/,
];

export function isKnownLlmPath(path: string): boolean {
  return KNOWN_LLM_PATHS.some((pattern) => pattern.test(path));
}

export function shouldCaptureRequest(c: Context): boolean {
  const path = c.req.path;
  if (
    path.startsWith("/admin/") ||
    path.startsWith("/assets/") ||
    path === "/admin" ||
    path === "/health" ||
    path === "/favicon.ico" ||
    path === "/" ||
    path === "/index.html"
  ) {
    return false;
  }
  const config = getConfig();
  if (!config.logs.llm_only) return true;
  if (c.get("logForwarded") === true) return true;
  return isKnownLlmPath(path);
}

export async function logCapture(c: Context, next: Next): Promise<void> {
  const startMs = Date.now();
  await next();
  if (!shouldCaptureRequest(c)) return;

  const requestId = c.get("requestId") ?? "-";
  const metrics = c.get("metrics");
  const duration = metrics?.durationMs ?? (Date.now() - startMs);

  const usagePayload = metrics?.inputTokens != null ? {
    input_tokens: metrics.inputTokens,
    output_tokens: metrics.outputTokens ?? 0,
    cached_tokens: metrics.cachedTokens ?? undefined,
    reasoning_tokens: metrics.reasoningTokens ?? undefined,
  } : undefined;

  const updated = updateLogEntry(requestId, {
    status: c.res.status,
    latencyMs: duration,
    ttftMs: metrics?.ttftMs,
    durationMs: duration,
    costUsd: metrics?.costUsd,
    tokensPerSecond: metrics?.tokensPerSecond,
    usage: usagePayload,
    metrics: metrics ?? undefined,
  });

  if (!updated) {
    enqueueLogEntry({
      requestId,
      direction: "ingress",
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      latencyMs: duration,
      ttftMs: metrics?.ttftMs,
      durationMs: duration,
      costUsd: metrics?.costUsd,
      tokensPerSecond: metrics?.tokensPerSecond,
      usage: usagePayload,
      metrics: metrics ?? undefined,
    });
  }
}
