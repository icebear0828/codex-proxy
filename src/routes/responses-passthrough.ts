/**
 * Responses API passthrough translators — stream and collect paths.
 *
 * Accepts raw Codex SSE events and either streams them directly to the client
 * (streamPassthrough) or collects into a single JSON response (collectPassthrough).
 */

import { randomUUID } from "crypto";
import type { UpstreamAdapter } from "../proxy/upstream-adapter.js";
import type { CodexSSEEvent } from "../proxy/codex-api.js";
import { EmptyResponseError } from "../translation/codex-event-extractor.js";
import { reconvertTupleValues } from "../translation/tuple-schema.js";
import { extractCodexError } from "../types/codex-events.js";
import { recordStreamCloseEvent } from "../logs/stream-close-event.js";
import type { FormatAdapter, StreamTranslatorContext } from "./shared/proxy-handler-types.js";

// ── Shared helpers ────────────────────────────────────────────────

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function extractOutputTextFromItem(item: unknown): string {
  if (!isRecord(item) || !Array.isArray(item.content)) return "";
  const chunks: string[] = [];
  for (const part of item.content) {
    if (
      isRecord(part) &&
      (part.type === "output_text" || part.type === "text") &&
      typeof part.text === "string"
    ) {
      chunks.push(part.text);
    }
  }
  return chunks.join("");
}

export function syncOutputTextFromOutput(response: Record<string, unknown>): void {
  if (!Array.isArray(response.output)) return;
  const texts = (response.output as unknown[]).map(extractOutputTextFromItem).filter(Boolean);
  if (texts.length > 0) response.output_text = texts.join("\n\n");
}

// ── Stream error builders ─────────────────────────────────────────

const STREAM_DISCONNECTED_CODE = "stream_disconnected";
const STREAM_DISCONNECTED_MESSAGE = "Upstream stream closed before response.completed";

interface ResponsesStreamError {
  type: string;
  code: string;
  message: string;
}

function isTerminalResponsesEvent(event: string): boolean {
  return event === "response.completed" || event === "response.failed" || event === "error";
}

function extractResponseIdFromEventData(data: unknown): string | null {
  if (!isRecord(data) || !isRecord(data.response)) return null;
  return typeof data.response.id === "string" ? data.response.id : null;
}

function buildPrematureCloseFailedEvent(responseId: string | null, detail?: string): string {
  const message = detail ? `${STREAM_DISCONNECTED_MESSAGE}: ${detail}` : STREAM_DISCONNECTED_MESSAGE;
  return buildResponseFailedEvent(responseId, {
    type: "server_error",
    code: STREAM_DISCONNECTED_CODE,
    message,
  });
}

function buildResponseFailedEvent(responseId: string | null, error: ResponsesStreamError): string {
  const id = responseId ?? `resp_proxy_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  return `event: response.failed\ndata: ${JSON.stringify({
    type: "response.failed",
    response: {
      id,
      status: "failed",
      error,
    },
    error,
  })}\n\n`;
}

function stripCodexErrorPrefix(message: string): string {
  return message.replace(/^Codex API error \(\d+\):\s*/, "");
}

function classifyResponsesStreamError(status: number, message: string): ResponsesStreamError {
  const cleanMessage = stripCodexErrorPrefix(message);
  if (status === 429) {
    return {
      type: "rate_limit_error",
      code: "rate_limit_exceeded",
      message: cleanMessage,
    };
  }
  if (status === 401 || status === 403) {
    return {
      type: "invalid_request_error",
      code: "authentication_error",
      message: cleanMessage,
    };
  }
  if (cleanMessage.toLowerCase().includes("error sending request")) {
    return {
      type: "server_error",
      code: "upstream_transport_error",
      message: cleanMessage,
    };
  }
  return {
    type: status >= 400 && status < 500 ? "invalid_request_error" : "server_error",
    code: "codex_api_error",
    message: cleanMessage,
  };
}

export function buildResponsesStreamError(status: number, message: string): string {
  return buildResponseFailedEvent(null, classifyResponsesStreamError(status, message));
}

// ── Usage extraction ──────────────────────────────────────────────

/** Extract usage from a response.completed payload, including cached_tokens
 *  (nested in input_tokens_details per the OpenAI Responses API contract). */
export function extractResponseUsage(usage: Record<string, unknown>): { input_tokens: number; output_tokens: number; cached_tokens?: number } {
  const result: { input_tokens: number; output_tokens: number; cached_tokens?: number } = {
    input_tokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
    output_tokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
  };
  const inputDetails = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : null;
  if (inputDetails && typeof inputDetails.cached_tokens === "number") {
    result.cached_tokens = inputDetails.cached_tokens;
  }
  return result;
}

/** Extract image_generation tool tokens from a response payload's tool_usage.image_gen
 *  block. Returns undefined when no image generation occurred (or counts are zero). */
export function extractImageGenUsage(response: Record<string, unknown>): { image_input_tokens: number; image_output_tokens: number } | undefined {
  if (!isRecord(response.tool_usage)) return undefined;
  const img = response.tool_usage.image_gen;
  if (!isRecord(img)) return undefined;
  const image_input_tokens = typeof img.input_tokens === "number" ? img.input_tokens : 0;
  const image_output_tokens = typeof img.output_tokens === "number" ? img.output_tokens : 0;
  if (image_input_tokens === 0 && image_output_tokens === 0) return undefined;
  return { image_input_tokens, image_output_tokens };
}

// ── Stream passthrough ────────────────────────────────────────────

export async function* streamPassthrough(
  api: UpstreamAdapter,
  response: Response,
  model: string,
  onUsage: (u: { input_tokens: number; output_tokens: number; cached_tokens?: number; image_input_tokens?: number; image_output_tokens?: number }) => void,
  onResponseId: (id: string) => void,
  tupleSchema?: Record<string, unknown> | null,
  streamContext?: StreamTranslatorContext,
  onResponseCompleted?: (id?: string) => void,
  onResponseMetadata?: (metadata: { functionCallIds?: string[] }) => void,
): AsyncGenerator<string> {
  let tupleTextBuffer = tupleSchema ? "" : null;
  let sawTerminal = false;
  let responseId: string | null = null;
  const streamFunctionCallIds = new Set<string>();

  const stream = api.parseStream(response);
  let upstreamDone = false;
  try {
    while (true) {
      let next: IteratorResult<CodexSSEEvent>;
      try {
        next = await stream.next();
      } catch (err) {
        if (sawTerminal) return;
        if (streamContext?.abortSignal?.aborted) return;
        const detail = err instanceof Error ? err.message : String(err);
        console.warn(
          `[Responses] premature stream close before terminal event responseId=${responseId ?? "unknown"}: ${detail}`,
        );
        recordStreamCloseEvent({
          kind: "upstream-premature",
          tag: streamContext?.tag ?? "Responses",
          requestId: streamContext?.requestId,
          provider: streamContext?.provider,
          path: streamContext?.path,
          model: streamContext?.model ?? model,
          accountEntryId: streamContext?.accountEntryId,
          variantHash: streamContext?.variantHash,
          responseId,
          detail,
        });
        yield buildPrematureCloseFailedEvent(responseId, detail);
        return;
      }

      if (next.done) {
        upstreamDone = true;
        break;
      }

      const raw = next.value;
      responseId = extractResponseIdFromEventData(raw.data) ?? responseId;
      if (isTerminalResponsesEvent(raw.event)) sawTerminal = true;

      if (tupleTextBuffer !== null && raw.event === "response.output_text.delta") {
        const data = raw.data;
        if (isRecord(data) && typeof data.delta === "string") {
          tupleTextBuffer += data.delta;
          continue;
        }
      }

      if (tupleTextBuffer !== null && tupleSchema && raw.event === "response.completed") {
        if (tupleTextBuffer) {
          let reconvertedText = tupleTextBuffer;
          try {
            const parsed = JSON.parse(tupleTextBuffer) as unknown;
            reconvertedText = JSON.stringify(reconvertTupleValues(parsed, tupleSchema));
          } catch (e) {
            console.warn("[tuple-reconvert] streaming JSON parse failed, emitting raw text:", e);
          }
          yield `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: reconvertedText })}\n\n`;
        }
        const data = raw.data;
        if (isRecord(data) && isRecord(data.response) && tupleTextBuffer) {
          const resp = data.response;
          if (Array.isArray(resp.output)) {
            for (const item of resp.output as unknown[]) {
              if (isRecord(item) && Array.isArray(item.content)) {
                for (const part of item.content as unknown[]) {
                  if (
                    isRecord(part) &&
                    (part.type === "output_text" || part.type === "text") &&
                    typeof part.text === "string"
                  ) {
                    try {
                      const parsed = JSON.parse(part.text) as unknown;
                      part.text = JSON.stringify(reconvertTupleValues(parsed, tupleSchema));
                    } catch { /* leave as-is */ }
                  }
                }
              }
            }
          }
        }
      }

      yield `event: ${raw.event}\ndata: ${JSON.stringify(raw.data)}\n\n`;

      if (raw.event === "response.output_item.done") {
        const data = raw.data;
        if (isRecord(data) && isRecord(data.item) && data.item.type === "function_call") {
          const callId = data.item.call_id;
          if (typeof callId === "string" && callId) streamFunctionCallIds.add(callId);
        }
      }

      if (
        raw.event === "response.created" ||
        raw.event === "response.in_progress" ||
        raw.event === "response.completed"
      ) {
        const data = raw.data;
        if (isRecord(data) && isRecord(data.response)) {
          const resp = data.response;
          if (typeof resp.id === "string") onResponseId(resp.id);
          if (raw.event === "response.completed" && isRecord(resp.usage)) {
            const imgUsage = extractImageGenUsage(resp);
            onUsage({ ...extractResponseUsage(resp.usage), ...(imgUsage ?? {}) });
          }
          if (raw.event === "response.completed") {
            onResponseCompleted?.(typeof resp.id === "string" ? resp.id : undefined);
            if (streamFunctionCallIds.size > 0) {
              onResponseMetadata?.({ functionCallIds: [...streamFunctionCallIds] });
            }
          }
        }
      }
    }
  } finally {
    if (!upstreamDone) {
      try { await stream.return(undefined); } catch { /* cleanup best effort */ }
    }
  }

  if (!sawTerminal) {
    if (streamContext?.abortSignal?.aborted) return;
    console.warn(
      `[Responses] premature stream close before terminal event responseId=${responseId ?? "unknown"}`,
    );
    recordStreamCloseEvent({
      kind: "upstream-premature",
      tag: streamContext?.tag ?? "Responses",
      requestId: streamContext?.requestId,
      provider: streamContext?.provider,
      path: streamContext?.path,
      model: streamContext?.model ?? model,
      accountEntryId: streamContext?.accountEntryId,
      variantHash: streamContext?.variantHash,
      responseId,
    });
    yield buildPrematureCloseFailedEvent(responseId);
  }
}

// ── Collect passthrough ───────────────────────────────────────────

export async function collectPassthrough(
  api: UpstreamAdapter,
  response: Response,
  _model: string,
  tupleSchema?: Record<string, unknown> | null,
  onResponseMetadata?: (metadata: { functionCallIds?: string[] }) => void,
): Promise<{
  response: unknown;
  usage: { input_tokens: number; output_tokens: number; cached_tokens?: number; image_input_tokens?: number; image_output_tokens?: number };
  responseId: string | null;
}> {
  let finalResponse: unknown = null;
  let usage: { input_tokens: number; output_tokens: number; cached_tokens?: number; image_input_tokens?: number; image_output_tokens?: number } = { input_tokens: 0, output_tokens: 0 };
  let responseId: string | null = null;
  const outputItems: unknown[] = [];
  const collectFunctionCallIds = new Set<string>();
  let textDeltas = "";

  try {
    for await (const raw of api.parseStream(response)) {
      const data = raw.data;
      if (!isRecord(data)) continue;
      const resp = isRecord(data.response) ? data.response : null;

      if (raw.event === "response.created" || raw.event === "response.in_progress") {
        if (resp && typeof resp.id === "string") responseId = resp.id;
      }

      if (raw.event === "response.output_text.delta" && typeof data.delta === "string") {
        textDeltas += data.delta;
      }

      if (raw.event === "response.output_item.done" && isRecord(data.item)) {
        outputItems.push(data.item);
        if (data.item.type === "function_call" && typeof data.item.call_id === "string" && data.item.call_id) {
          collectFunctionCallIds.add(data.item.call_id as string);
        }
      }

      if (raw.event === "response.completed" && resp) {
        if (collectFunctionCallIds.size > 0) {
          onResponseMetadata?.({ functionCallIds: [...collectFunctionCallIds] });
        }
        if (!Array.isArray(resp.output) || resp.output.length === 0) {
          if (outputItems.length > 0) {
            resp.output = outputItems;
          } else if (textDeltas) {
            resp.output = [{
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: textDeltas }],
            }];
          }
        }
        if (typeof resp.output_text !== "string" || !resp.output_text) {
          syncOutputTextFromOutput(resp);
        }
        finalResponse = resp;
        if (typeof resp.id === "string") responseId = resp.id;
        if (isRecord(resp.usage)) {
          const imgUsage = extractImageGenUsage(resp);
          usage = { ...extractResponseUsage(resp.usage), ...(imgUsage ?? {}) };
        }
      }

      if (raw.event === "error" || raw.event === "response.failed") {
        const err = extractCodexError(data);
        throw new Error(
          `Codex API error: ${err.code}: ${err.message}`,
        );
      }
    }
  } catch (streamErr) {
    if (!finalResponse) {
      throw new EmptyResponseError(responseId, usage);
    }
    throw streamErr;
  }

  if (!finalResponse) {
    throw new EmptyResponseError(responseId, usage);
  }

  if (tupleSchema && isRecord(finalResponse)) {
    const resp = finalResponse;
    if (Array.isArray(resp.output)) {
      for (const item of resp.output as unknown[]) {
        if (isRecord(item) && Array.isArray(item.content)) {
          for (const part of item.content as unknown[]) {
            if (
              isRecord(part) &&
              (part.type === "output_text" || part.type === "text") &&
              typeof part.text === "string"
            ) {
              try {
                const parsed = JSON.parse(part.text) as unknown;
                part.text = JSON.stringify(reconvertTupleValues(parsed, tupleSchema));
              } catch (e) {
                console.warn("[tuple-reconvert] collect JSON parse failed, passing through:", e);
              }
            }
          }
        }
      }
      syncOutputTextFromOutput(resp);
    }
  }

  return { response: finalResponse, usage, responseId };
}

// ── Format adapter ────────────────────────────────────────────────

export const PASSTHROUGH_FORMAT: FormatAdapter = {
  tag: "Responses",
  noAccountStatus: 503,
  formatNoAccount: () => ({
    type: "error",
    error: {
      type: "server_error",
      code: "no_available_accounts",
      message: "No available accounts. All accounts are expired or rate-limited.",
    },
  }),
  format429: (msg) => ({
    type: "error",
    error: {
      type: "rate_limit_error",
      code: "rate_limit_exceeded",
      message: msg,
    },
  }),
  formatError: (_status, msg) => ({
    type: "error",
    error: {
      type: "server_error",
      code: "codex_api_error",
      message: msg,
    },
  }),
  formatStreamError: (status, msg) => buildResponsesStreamError(status, msg),
  streamTranslator: ({ api, response, model, onUsage, onResponseId, onResponseCompleted, tupleSchema, streamContext, onResponseMetadata }) =>
    streamPassthrough(api, response, model, onUsage, onResponseId, tupleSchema, streamContext, onResponseCompleted, onResponseMetadata),
  collectTranslator: ({ api, response, model, tupleSchema, onResponseMetadata }) =>
    collectPassthrough(api, response, model, tupleSchema, onResponseMetadata),
};
