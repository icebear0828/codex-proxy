/**
 * POST /v1/responses — Codex Responses API passthrough.
 *
 * Accepts the native Codex Responses API format and streams raw SSE events
 * back to the client without translation. Provides multi-account load balancing,
 * retry logic, and usage tracking via the shared proxy handler.
 */

import { Hono, type Context } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import type { AccountPool } from "../auth/account-pool.js";
import type { CookieJar } from "../proxy/cookie-jar.js";
import type { ProxyPool } from "../proxy/proxy-pool.js";
import { CodexApi, CodexApiError } from "../proxy/codex-api.js";
import type { CodexResponsesRequest, CodexCompactRequest, CodexInputItem } from "../proxy/codex-api.js";
import type { UpstreamAdapter } from "../proxy/upstream-adapter.js";
import { getConfig } from "../config.js";
import { prepareSchema } from "../translation/shared-utils.js";
import { reconvertTupleValues } from "../translation/tuple-schema.js";
import { parseModelName, resolveModelId, getModelInfo, buildDisplayModelName } from "../models/model-store.js";
import { EmptyResponseError } from "../translation/codex-event-extractor.js";
import {
  handleProxyRequest,
  handleDirectRequest,
  staggerIfNeeded,
  type FormatAdapter,
} from "./shared/proxy-handler.js";
import type { UpstreamRouter } from "../proxy/upstream-router.js";
import { acquireAccount, releaseAccount } from "./shared/account-acquisition.js";
import { handleCodexApiError } from "./shared/proxy-error-handler.js";
import { withRetry } from "../utils/retry.js";
import { extractCodexError } from "../types/codex-events.js";

// ── Helpers ────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
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

function syncOutputTextFromOutput(response: Record<string, unknown>): void {
  if (!Array.isArray(response.output)) return;
  const outputText = (response.output as unknown[])
    .map(extractOutputTextFromItem)
    .join("");
  if (outputText) response.output_text = outputText;
}

// ── Passthrough stream translator ──────────────────────────────────

async function* streamPassthrough(
  api: UpstreamAdapter,
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
  api: UpstreamAdapter,
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
  const outputItems: unknown[] = [];
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
      }

      if (raw.event === "response.completed" && resp) {
        // Codex hosted search 经常完整流出 output_item.done/text delta，
        // 但 completed.response.output 为空。这里用流式事件回填最终 JSON。
        if (Array.isArray(resp.output) && resp.output.length === 0) {
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
          usage = {
            input_tokens: typeof resp.usage.input_tokens === "number" ? resp.usage.input_tokens : 0,
            output_tokens: typeof resp.usage.output_tokens === "number" ? resp.usage.output_tokens : 0,
          };
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

  // Reconvert tuple objects back to arrays in output text
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

// ── Shared auth check ─────────────────────────────────────────────

function checkAuth(
  c: Context,
  accountPool: AccountPool,
  allowUnauthenticated: boolean = false,
): Response | null {
  if (!allowUnauthenticated && !accountPool.isAuthenticated()) {
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
  return null;
}

function parseBody(c: Context, body: unknown): Record<string, unknown> | Response {
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
  return body;
}

function formatResponsesError(status: number, msg: string): unknown {
  return {
    type: "error",
    error: {
      type: "server_error",
      code: "codex_api_error",
      message: msg,
    },
  };
}

// ── Build CodexApi helper ─────────────────────────────────────────

function buildCodexApi(
  token: string,
  accountId: string | null,
  cookieJar: CookieJar | undefined,
  entryId: string,
  proxyPool?: ProxyPool,
): CodexApi {
  const proxyUrl = proxyPool?.resolveProxyUrl(entryId);
  return new CodexApi(token, accountId, cookieJar, entryId, proxyUrl);
}

// ── Compact handler (non-streaming JSON proxy) ────────────────────

async function handleCompact(
  c: Context,
  accountPool: AccountPool,
  cookieJar: CookieJar | undefined,
  proxyPool: ProxyPool | undefined,
  body: Record<string, unknown>,
  upstreamRouter?: UpstreamRouter,
): Promise<Response> {
  const rawModel = typeof body.model === "string" ? body.model : "codex";
  const parsed = parseModelName(rawModel);
  const modelId = resolveModelId(parsed.modelId);

  // Build CodexCompactRequest — matches codex-rs CompactionInput
  const compactRequest: CodexCompactRequest = {
    model: modelId,
    input: Array.isArray(body.input) ? (body.input as CodexInputItem[]) : [],
    instructions: typeof body.instructions === "string" ? body.instructions : "",
  };
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    compactRequest.tools = body.tools;
  }
  if (typeof body.parallel_tool_calls === "boolean") {
    compactRequest.parallel_tool_calls = body.parallel_tool_calls;
  }
  if (isRecord(body.reasoning)) {
    const r: Record<string, string> = {};
    if (typeof body.reasoning.effort === "string") r.effort = body.reasoning.effort;
    if (typeof body.reasoning.summary === "string") r.summary = body.reasoning.summary;
    if (Object.keys(r).length > 0) compactRequest.reasoning = r;
  }
  if (
    isRecord(body.text) &&
    isRecord(body.text.format) &&
    typeof body.text.format.type === "string"
  ) {
    compactRequest.text = {
      format: {
        type: body.text.format.type as "text" | "json_object" | "json_schema",
        ...(typeof body.text.format.name === "string" ? { name: body.text.format.name } : {}),
        ...(isRecord(body.text.format.schema) ? { schema: body.text.format.schema as Record<string, unknown> } : {}),
        ...(typeof body.text.format.strict === "boolean" ? { strict: body.text.format.strict } : {}),
      },
    };
  }

  const compactRouteMatch = upstreamRouter?.resolveMatch(rawModel);
  if (compactRouteMatch?.kind === "api-key" || compactRouteMatch?.kind === "adapter") {
    const directReq = {
      codexRequest: {
        model: rawModel,
        input: compactRequest.input,
        instructions: compactRequest.instructions,
        stream: true as const,
        store: false as const,
        ...(compactRequest.tools ? { tools: compactRequest.tools } : {}),
        ...(compactRequest.parallel_tool_calls !== undefined
          ? { parallel_tool_calls: compactRequest.parallel_tool_calls }
          : {}),
        ...(compactRequest.reasoning ? { reasoning: compactRequest.reasoning } : {}),
        ...(compactRequest.text ? { text: compactRequest.text } : {}),
      },
      model: rawModel,
      isStreaming: false,
    };
    return handleDirectRequest(c, compactRouteMatch.adapter, directReq, PASSTHROUGH_FORMAT);
  }

  // Acquire account
  const TAG = "Compact";
  const triedEntryIds: string[] = [];
  const released = new Set<string>();

  const acquired = acquireAccount(accountPool, modelId, undefined, TAG);
  if (!acquired) {
    c.status(503);
    return c.json(formatResponsesError(503, "No available accounts. All accounts are expired or rate-limited."));
  }

  let entryId = acquired.entryId;
  triedEntryIds.push(entryId);
  let codexApi = buildCodexApi(acquired.token, acquired.accountId, cookieJar, entryId, proxyPool);

  console.log(
    `[${TAG}] Account ${entryId} | model=${modelId} | input_items=${compactRequest.input.length}`,
  );

  await staggerIfNeeded(acquired.prevSlotMs);

  for (;;) {
    try {
      const result = await withRetry(
        () => codexApi.createCompactResponse(compactRequest, c.req.raw.signal),
        { tag: TAG },
      );

      releaseAccount(accountPool, entryId, undefined, released);
      return c.json(result);
    } catch (err) {
      if (!(err instanceof CodexApiError)) {
        releaseAccount(accountPool, entryId, undefined, released);
        throw err;
      }

      const decision = handleCodexApiError(
        err, accountPool, entryId, modelId, TAG, false,
      );

      if (decision.action === "respond") {
        releaseAccount(accountPool, entryId, undefined, released);
        c.status(decision.status as StatusCode);
        return c.json(formatResponsesError(decision.status, decision.message));
      }

      if (decision.releaseBeforeRetry) {
        releaseAccount(accountPool, entryId, undefined, released);
      }

      const retry = acquireAccount(accountPool, modelId, triedEntryIds, TAG);
      if (!retry) {
        const status = decision.status as StatusCode;
        c.status(status);
        if (decision.useFormat429) {
          return c.json({
            type: "error",
            error: {
              type: "rate_limit_error",
              code: "rate_limit_exceeded",
              message: decision.message,
            },
          });
        }
        return c.json(formatResponsesError(status, decision.message));
      }

      entryId = retry.entryId;
      triedEntryIds.push(entryId);
      codexApi = buildCodexApi(retry.token, retry.accountId, cookieJar, entryId, proxyPool);
      console.log(`[${TAG}] Fallback → account ${retry.entryId}`);
      await staggerIfNeeded(retry.prevSlotMs);
      continue;
    }
  }
}

// ── Route ──────────────────────────────────────────────────────────

export function createResponsesRoutes(
  accountPool: AccountPool,
  cookieJar?: CookieJar,
  proxyPool?: ProxyPool,
  upstreamRouter?: UpstreamRouter,
): Hono {
  const app = new Hono();

  // ── POST /v1/responses — streaming SSE passthrough ──

  const responsesHandler = async (c: Context) => {
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
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

    const body = parseBody(c, rawBody);
    if (body instanceof Response) return body;

    const rawModel = typeof body.model === "string" ? body.model : "codex";
    const routeMatch = upstreamRouter?.resolveMatch(rawModel);
    const allowUnauthenticated = routeMatch?.kind === "api-key" || routeMatch?.kind === "adapter";
    const authErr = checkAuth(c, accountPool, allowUnauthenticated);
    if (authErr) return authErr;

    const config = getConfig();
    const parsed = parseModelName(rawModel);
    const modelId = resolveModelId(parsed.modelId);
    const displayModel = buildDisplayModelName(parsed);
    const modelInfo = getModelInfo(modelId);

    const codexRequest: CodexResponsesRequest = {
      model: modelId,
      instructions: typeof body.instructions === "string" ? body.instructions : "",
      input: Array.isArray(body.input) ? (body.input as CodexInputItem[]) : [],
      stream: true,
      store: false,
    };

    codexRequest.useWebSocket = true;
    if (typeof body.previous_response_id === "string") {
      codexRequest.previous_response_id = body.previous_response_id;
    }

    // Reasoning effort: explicit body > suffix > config default
    const effort =
      (isRecord(body.reasoning) && typeof body.reasoning.effort === "string"
        ? body.reasoning.effort
        : null) ??
      parsed.reasoningEffort ??
      config.model.default_reasoning_effort;
    const clientReasoningRecord = isRecord(body.reasoning) ? body.reasoning : null;
    if (effort || clientReasoningRecord) {
      const summary =
        clientReasoningRecord && typeof clientReasoningRecord.summary === "string"
          ? clientReasoningRecord.summary
          : "auto";
      codexRequest.reasoning = { summary, ...(effort ? { effort } : {}) };
    }

    // Service tier
    const serviceTier =
      (typeof body.service_tier === "string" ? body.service_tier : null) ??
      parsed.serviceTier ??
      config.model.default_service_tier ??
      null;
    if (serviceTier) {
      codexRequest.service_tier = serviceTier;
    }

    if (Array.isArray(body.tools) && body.tools.length > 0) {
      codexRequest.tools = body.tools;
    }
    if (body.tool_choice !== undefined) {
      codexRequest.tool_choice = body.tool_choice as CodexResponsesRequest["tool_choice"];
    }

    // Text format (JSON mode / structured outputs)
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

    const clientWantsStream = body.stream !== false;
    const proxyReq = {
      codexRequest,
      model: displayModel,
      isStreaming: clientWantsStream,
      tupleSchema,
    };

    if (routeMatch?.kind === "api-key" || routeMatch?.kind === "adapter") {
      // Use raw model name so adapter's extractModelId can strip the provider prefix
      const directReq = { ...proxyReq, codexRequest: { ...codexRequest, model: rawModel } };
      return handleDirectRequest(c, routeMatch.adapter, directReq, PASSTHROUGH_FORMAT);
    }

    return handleProxyRequest(c, accountPool, cookieJar, proxyReq, PASSTHROUGH_FORMAT, proxyPool);
  };

  // ── POST /v1/responses/compact — non-streaming JSON proxy ──

  const compactHandler = async (c: Context) => {
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
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

    const body = parseBody(c, rawBody);
    if (body instanceof Response) return body;

    const rawModel = typeof body.model === "string" ? body.model : "codex";
    const routeMatch = upstreamRouter?.resolveMatch(rawModel);
    const allowUnauthenticated = routeMatch?.kind === "api-key" || routeMatch?.kind === "adapter";
    const authErr = checkAuth(c, accountPool, allowUnauthenticated);
    if (authErr) return authErr;

    return handleCompact(c, accountPool, cookieJar, proxyPool, body, upstreamRouter);
  };

  app.post("/v1/responses", responsesHandler);
  app.post("/v1/responses/compact", compactHandler);

  return app;
}
