/**
 * SSE stream parser for Codex Responses API.
 * Pure functions — no side effects or external dependencies.
 */

import type { CodexSSEEvent } from "./codex-types.js";

export function parseSSEBlock(block: string): CodexSSEEvent | null {
  let event = "";
  const dataLines: string[] = [];
  let dataStarted = false;

  for (const line of block.split("\n")) {
    const normalizedLine = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (normalizedLine.startsWith("event:")) {
      event = normalizedLine.slice(6).trim();
    } else if (normalizedLine.startsWith("data:")) {
      dataStarted = true;
      dataLines.push(normalizedLine.slice(5).trimStart());
    } else if (
      dataStarted &&
      !normalizedLine.startsWith("id:") &&
      !normalizedLine.startsWith("retry:") &&
      !normalizedLine.startsWith(":")
    ) {
      // 兼容非标准上游错误流：JSON 被漂亮打印成多行，但续行没有重复 data: 前缀。
      dataLines.push(normalizedLine);
    }
  }

  if (!event && dataLines.length === 0) return null;

  const raw = dataLines.join("\n");
  if (raw === "[DONE]") return null;

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    data = raw;
  }

  return { event, data };
}

const MAX_SSE_BUFFER = 10 * 1024 * 1024; // 10MB

export async function* parseSSEStream(
  response: Response,
): AsyncGenerator<CodexSSEEvent> {
  if (!response.body) {
    throw new Error("Response body is null — cannot stream");
  }

  const reader = response.body
    .pipeThrough(new TextDecoderStream())
    .getReader();

  let buffer = "";
  let yieldedAny = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += value;
      if (buffer.length > MAX_SSE_BUFFER) {
        throw new Error(`SSE buffer exceeded ${MAX_SSE_BUFFER} bytes — aborting stream`);
      }
      const parts = buffer.split("\n\n");
      buffer = parts.pop()!;

      for (const part of parts) {
        if (!part.trim()) continue;
        const evt = parseSSEBlock(part);
        if (evt) {
          yieldedAny = true;
          yield evt;
        }
      }
    }

    // Process remaining buffer
    if (buffer.trim()) {
      const evt = parseSSEBlock(buffer);
      if (evt) {
        yieldedAny = true;
        yield evt;
      }
    }

    // Non-SSE response detection
    if (!yieldedAny && buffer.trim()) {
      let errorMessage = buffer.trim();
      try {
        const parsed = JSON.parse(errorMessage) as Record<string, unknown>;
        const errObj = typeof parsed.error === "object" && parsed.error !== null
          ? (parsed.error as Record<string, unknown>)
          : undefined;
        errorMessage =
          (typeof parsed.detail === "string" ? parsed.detail : null)
          ?? (typeof errObj?.message === "string" ? errObj.message : null)
          ?? errorMessage;
      } catch { /* use raw text */ }
      yield {
        event: "error",
        data: { error: { type: "error", code: "non_sse_response", message: errorMessage } },
      };
    }
  } finally {
    reader.releaseLock();
  }
}
