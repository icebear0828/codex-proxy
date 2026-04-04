/**
 * POST /v1/responses — Codex Responses API passthrough.
 *
 * Accepts the native Codex Responses API format and streams raw SSE events
 * back to the client without translation. Provides multi-account load balancing,
 * retry logic, and usage tracking via the shared proxy handler.
 */

import { Hono } from "hono";
import type { AccountPool } from "../auth/account-pool.js";
import type { CookieJar } from "../proxy/cookie-jar.js";
import type { ProxyPool } from "../proxy/proxy-pool.js";
import type { CodexResponsesRequest, CodexInputItem, CodexApi } from "../proxy/codex-api.js";
import { getConfig } from "../config.js";
import { prepareSchema } from "../translation/shared-utils.js";
import { reconvertTupleValues } from "../translation/tuple-schema.js";
import { parseModelName, resolveModelId, getModelInfo, buildDisplayModelName } from "../models/model-store.js";
import { EmptyResponseError } from "../translation/codex-event-extractor.js";
import {
  handleProxyRequest,
  type FormatAdapter,
} from "./shared/proxy-handler.js";

// ── Helpers ────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ── Passthrough stream translator ──────────────────────────────────

async function* streamPassthrough(
  api: CodexApi,
  response: Response,
  _model: string,
  onUsage: (u: { input_tokens: number; output_tokens: number }) => void,
  onResponseId: (id: string) => void,
  tupleSchema?: Record<string, unknown> | null,
): AsyncGenerator<string> {
  // When tupleSchema is present, buffer text deltas and reconvert on completion.
  // This means the client receives zero incremental text — all text arrives at once
  // after response.completed. This is a known tradeoff for tuple reconversion correctness.
  let tupleTextBuffer = tupleSchema ? "" : null;

  for await (const raw of api.parseStream(response)) {
    // Buffer text deltas when tuple reconversion is active
    if (tupleTextBuffer !== null && raw.event === "response.output_text.delta") {
      const data = raw.data;
      if (isRecord(data) && typeof data.delta === "string") {
        tupleTextBuffer += data.delta;
        continue; // suppress this event — will flush reconverted text on completion
      }
    }

    // On completion, flush reconverted text before emitting the completed event
    if (tupleTextBuffer !== null && tupleSchema && raw.event === "response.completed") {
      if (tupleTextBuffer) {
        let reconvertedText = tupleTextBuffer;
        try {
          const parsed = JSON.parse(tupleTextBuffer) as unknown;
          reconvertedText = JSON.stringify(reconvertTupleValues(parsed, tupleSchema));
        } catch (e) {
          console.warn("[tuple-reconvert] streaming JSON parse failed, emitting raw text:", e);
        }
        // Emit a single text delta with reconverted content
        yield `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: reconvertedText })}\n\n`;
      }
      // Patch the completed event's output text if present
      const data = raw.data;
      if (isRecord(data) && isRecord(data.response) && tupleTextBuffer) {
        const resp = data.response;
        if (Array.isArray(resp.output)) {
          for (const item of resp.output as unknown[]) {
            if (isRecord(item) && Array.isArray(item.content)) {
              for (const part of item.content as unknown[]) {
                if (isRecord(part) && part.type === "output_text" && typeof part.text === "string") {
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

    // Re-emit raw SSE event
    yield `event: ${raw.event}\ndata: ${JSON.stringify(raw.data)}\n\n`;

    // Extract usage and responseId for account pool bookkeeping
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
          onUsage({
            input_tokens: typeof resp.usage.input_tokens === "number" ? resp.usage.input_tokens : 0,
            output_tokens: typeof resp.usage.output_tokens === "number" ? resp.usage.output_tokens : 0,
          });
        }
      }
    }
  }
}

// ── Passthrough collect translator ─────────────────────────────────

export async function collectPassthrough(
  api: CodexApi,
  response: Response,
  _model: string,
  tupleSchema?: Record<string, unknown> | null,
): Promise<{
  response: unknown;
  usage: { input_tokens: number; output_tokens: number };
  responseId: string | null;
}> {
  let finalResponse: unknown = null;
  let usage = { input_tokens: 0, output_tokens: 0 };
  let responseId: string | null = null;

  try {
    for await (const raw of api.parseStream(response)) {
      const data = raw.data;
      if (!isRecord(data)) continue;
      const resp = isRecord(data.response) ? data.response : null;

      if (raw.event === "response.created" || raw.event === "response.in_progress") {
        if (resp && typeof resp.id === "string") responseId = resp.id;
      }

      if (raw.event === "response.completed" && resp) {
        finalResponse = resp;
        if (typeof resp.id === "string") responseId = resp.id;
        if (isRecord(resp.usage)) {
          usage = {
            input_tokens: typeof resp.usage.input_tokens === "number" ? resp.usage.input_tokens : 0,
            output_tokens: typeof resp.usage.output_tokens === "number" ? resp.usage.output_tokens : 0,
          };
        }
      }

      if (raw.event === "error" || raw.event === "response.failed") {
        const err = isRecord(data.error) ? data.error : data;
        throw new Error(
          `Codex API error: ${typeof err.code === "string" ? err.code : "unknown"}: ${typeof err.message === "string" ? err.message : JSON.stringify(data)}`,
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

  // Reconvert tuple objects back to arrays in output text
  if (tupleSchema && isRecord(finalResponse)) {
    const resp = finalResponse;
    if (Array.isArray(resp.output)) {
      for (const item of resp.output as unknown[]) {
        if (isRecord(item) && Array.isArray(item.content)) {
          for (const part of item.content as unknown[]) {
            if (isRecord(part) && part.type === "output_text" && typeof part.text === "string") {
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
    }
  }

  return { response: finalResponse, usage, responseId };
}

// ── Format adapter ─────────────────────────────────────────────────

const PASSTHROUGH_FORMAT: FormatAdapter = {
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
  streamTranslator: (api, response, model, onUsage, onResponseId, tupleSchema) =>
    streamPassthrough(api, response, model, onUsage, onResponseId, tupleSchema),
  collectTranslator: (api, response, model, tupleSchema) =>
    collectPassthrough(api, response, model, tupleSchema),
};

// ── Route ──────────────────────────────────────────────────────────

export function createResponsesRoutes(
  accountPool: AccountPool,
  cookieJar?: CookieJar,
  proxyPool?: ProxyPool,
): Hono {
  const app = new Hono();

  app.post("/v1/responses", async (c) => {
    // Auth check
    if (!accountPool.isAuthenticated()) {
      c.status(401);
      return c.json({
        type: "error",
        error: {
          type: "invalid_request_error",
          code: "invalid_api_key",
          message: "Not authenticated. Please login first at /",
        },
      });
    }

    // Optional proxy API key check
    const config = getConfig();
    if (config.server.proxy_api_key) {
      const authHeader = c.req.header("Authorization");
      const providedKey = authHeader?.replace("Bearer ", "");
      if (!providedKey || !accountPool.validateProxyApiKey(providedKey)) {
        c.status(401);
        return c.json({
          type: "error",
          error: {
            type: "invalid_request_error",
            code: "invalid_api_key",
            message: "Invalid proxy API key",
          },
        });
      }
    }

    // Parse request body
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      c.status(400);
      return c.json({
        type: "error",
        error: {
          type: "invalid_request_error",
          code: "invalid_json",
          message: "Malformed JSON request body",
        },
      });
    }

    if (!isRecord(body)) {
      c.status(400);
      return c.json({
        type: "error",
        error: {
          type: "invalid_request_error",
          code: "invalid_request",
          message: "Request body must be a JSON object",
        },
      });
    }

    // Resolve model (suffix parsing extracts service_tier and reasoning_effort)
    const rawModel = typeof body.model === "string" ? body.model : "codex";
    const parsed = parseModelName(rawModel);
    const modelId = resolveModelId(parsed.modelId);
    const displayModel = buildDisplayModelName(parsed);
    const modelInfo = getModelInfo(modelId);

    // Build CodexResponsesRequest
    // Codex API only supports streaming — stream/store are always true/false.
    // When client sends stream:false, the proxy collects SSE events and returns assembled JSON.
    const codexRequest: CodexResponsesRequest = {
      model: modelId,
      instructions: typeof body.instructions === "string" ? body.instructions : "",
      input: Array.isArray(body.input) ? (body.input as CodexInputItem[]) : [],
      stream: true,
      store: false,
    };

    // Responses API always uses WebSocket transport — enables server-side storage
    // and previous_response_id for multi-turn conversations.
    codexRequest.useWebSocket = true;
    if (typeof body.previous_response_id === "string") {
      codexRequest.previous_response_id = body.previous_response_id;
    }

    // Reasoning effort: explicit body > suffix > model default > config default
    const effort =
      (isRecord(body.reasoning) && typeof body.reasoning.effort === "string"
        ? body.reasoning.effort
        : null) ??
      parsed.reasoningEffort ??
      modelInfo?.defaultReasoningEffort ??
      config.model.default_reasoning_effort;
    const summary =
      isRecord(body.reasoning) && typeof body.reasoning.summary === "string"
        ? body.reasoning.summary
        : "auto";
    codexRequest.reasoning = { summary, ...(effort ? { effort } : {}) };

    // Service tier: explicit body > suffix > config default
    const serviceTier =
      (typeof body.service_tier === "string" ? body.service_tier : null) ??
      parsed.serviceTier ??
      config.model.default_service_tier ??
      null;
    if (serviceTier) {
      codexRequest.service_tier = serviceTier;
    }

    // Pass through tools and tool_choice as-is
    if (Array.isArray(body.tools) && body.tools.length > 0) {
      codexRequest.tools = body.tools;
    }
    if (body.tool_choice !== undefined) {
      codexRequest.tool_choice = body.tool_choice as CodexResponsesRequest["tool_choice"];
    }

    // Pass through text format (JSON mode / structured outputs) as-is
    let tupleSchema: Record<string, unknown> | null = null;
    if (
      isRecord(body.text) &&
      isRecord(body.text.format) &&
      typeof body.text.format.type === "string"
    ) {
      let formatSchema: Record<string, unknown> | undefined;
      if (isRecord(body.text.format.schema)) {
        const prepared = prepareSchema(body.text.format.schema as Record<string, unknown>);
        formatSchema = prepared.schema;
        tupleSchema = prepared.originalSchema;
      }
      codexRequest.text = {
        format: {
          type: body.text.format.type as "text" | "json_object" | "json_schema",
          ...(typeof body.text.format.name === "string"
            ? { name: body.text.format.name }
            : {}),
          ...(formatSchema ? { schema: formatSchema } : {}),
          ...(typeof body.text.format.strict === "boolean"
            ? { strict: body.text.format.strict }
            : {}),
        },
      };
    }

    // Client can request non-streaming (collect mode), but upstream is always stream
    const clientWantsStream = body.stream !== false;

    return handleProxyRequest(
      c,
      accountPool,
      cookieJar,
      {
        codexRequest,
        model: displayModel,
        isStreaming: clientWantsStream,
        tupleSchema,
      },
      PASSTHROUGH_FORMAT,
      proxyPool,
    );
  });

  return app;
}
