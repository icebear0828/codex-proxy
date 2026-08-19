/**
 * POST /v1/responses — Codex Responses API passthrough.
 *
 * Accepts the native Codex Responses API format and streams raw SSE events
 * back to the client without translation. Provides multi-account load balancing,
 * retry logic, and usage tracking via the shared proxy handler.
 */

import { Hono, type Context } from "hono";
import type { AccountPool } from "../auth/account-pool.js";
import type { CookieJar } from "../proxy/cookie-jar.js";
import type { ProxyPool } from "../proxy/proxy-pool.js";
import type { CodexResponsesRequest } from "../proxy/codex-api.js";
import { sanitizeCodexInputItems } from "../proxy/reasoning-input-sanitizer.js";
import { enqueueLogEntry } from "../logs/entry.js";
import { summarizeRequestForLog } from "../logs/request-summary.js";
import { getRealClientIp } from "../utils/get-real-client-ip.js";
import { randomUUID } from "crypto";
import { getConfig } from "../config.js";
import { apiKeyAuth } from "../middleware/api-key-auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { prepareSchema, isRecord } from "../translation/shared-utils.js";
import { parseModelName, resolveModelId, buildDisplayModelName } from "../models/model-store.js";
import { handleProxyRequest } from "./shared/proxy-handler.js";
import { handleDirectRequest } from "./shared/direct-request-handler.js";
import type { UpstreamRouter } from "../proxy/upstream-router.js";
import type { ClientKeyPool } from "../auth/client-key-pool.js";
import { validateClientKeyModel, recordClientKeyUsage } from "./shared/proxy-handler-utils.js";
import {
  extractOpenAISubagentFromMetadata,
  normalizeOpenAISubagent,
  OPENAI_SUBAGENT_HEADER,
  sanitizeClientMetadata,
} from "../proxy/openai-subagent.js";
import { PASSTHROUGH_FORMAT } from "./responses-passthrough.js";
import { handleCompact } from "./responses-compact.js";
import { resolveDefaultTools, mergeDefaultTools } from "./shared/default-tools.js";

// Re-export for downstream consumers
export { extractResponseUsage, extractImageGenUsage, streamPassthrough, collectPassthrough } from "./responses-passthrough.js";

const X_CODEX_TURN_STATE_HEADER = "x-codex-turn-state";
const X_CODEX_TURN_METADATA_HEADER = "x-codex-turn-metadata";
const X_CODEX_BETA_FEATURES_HEADER = "x-codex-beta-features";
const X_RESPONSESAPI_INCLUDE_TIMING_METRICS_HEADER = "x-responsesapi-include-timing-metrics";
const X_CODEX_PARENT_THREAD_ID_HEADER = "x-codex-parent-thread-id";
const X_CODEX_WINDOW_ID_HEADER = "x-codex-window-id";

// ── Helpers ───────────────────────────────────────────────────────

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstHeaderOrMetadata(
  c: Context,
  metadata: Record<string, string>,
  headerName: string,
): string | null {
  return nonEmptyString(c.req.header(headerName)) ?? nonEmptyString(metadata[headerName]);
}

// ── Auth check ────────────────────────────────────────────────────

function checkAuth(c: Context, accountPool: AccountPool, allowUnauthenticated: boolean): Response | null {
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

// ── Route ─────────────────────────────────────────────────────────

export function createResponsesRoutes(
  accountPool: AccountPool,
  cookieJar?: CookieJar,
  proxyPool?: ProxyPool,
  upstreamRouter?: UpstreamRouter,
  clientKeyPool?: ClientKeyPool,
): Hono {
  const app = new Hono();
  // Register errorHandler locally so that when testing this router in isolation (e.g. unit tests),
  // uncaught errors are still handled and formatted appropriately.
  app.onError(errorHandler);

  const responsesHandler = async (c: Context) => {
    const rawBody = await c.req.json();

    const body = parseBody(c, rawBody);
    if (body instanceof Response) return body;

    const rawModel = typeof body.model === "string" ? body.model : "codex";

    const modelCheck = validateClientKeyModel(c, rawModel);
    if (!modelCheck.allowed) {
      c.status(403);
      return c.json({
        type: "error",
        error: {
          type: "invalid_request_error",
          code: "model_not_allowed",
          message: modelCheck.message,
          param: "model",
        },
      });
    }

    const routeMatch = upstreamRouter?.resolveMatch(rawModel);
    const allowUnauthenticated = routeMatch?.kind === "api-key" || routeMatch?.kind === "adapter";
    const authErr = checkAuth(c, accountPool, allowUnauthenticated);
    if (authErr) return authErr;

    const config = getConfig();
    const parsed = parseModelName(rawModel);
    const modelId = resolveModelId(parsed.modelId);
    const displayModel = buildDisplayModelName(parsed);

    const codexRequest: CodexResponsesRequest = {
      model: modelId,
      instructions: typeof body.instructions === "string" ? body.instructions : "",
      input: Array.isArray(body.input) ? sanitizeCodexInputItems(body.input) : [],
      stream: true,
      store: false,
    };

    codexRequest.useWebSocket = true;
    const forcedReview = c.req.path === "/v1/responses/review" || c.req.path === "/responses/review";
    const openAiSubagent =
      forcedReview
        ? "review"
        : normalizeOpenAISubagent(c.req.header(OPENAI_SUBAGENT_HEADER)) ??
          extractOpenAISubagentFromMetadata(body.client_metadata);
    const clientMetadata = sanitizeClientMetadata(body.client_metadata);
    delete clientMetadata[OPENAI_SUBAGENT_HEADER];
    if (openAiSubagent) clientMetadata[OPENAI_SUBAGENT_HEADER] = openAiSubagent;
    if (Object.keys(clientMetadata).length > 0) {
      codexRequest.client_metadata = clientMetadata;
    }
    if (typeof body.previous_response_id === "string") {
      codexRequest.previous_response_id = body.previous_response_id;
    }
    if (typeof body.prompt_cache_key === "string") {
      codexRequest.prompt_cache_key = body.prompt_cache_key;
    }
    if (Array.isArray(body.include) && body.include.every((v) => typeof v === "string")) {
      codexRequest.include = body.include as string[];
    }
    codexRequest.turnState =
      nonEmptyString(body.turnState) ??
      firstHeaderOrMetadata(c, clientMetadata, X_CODEX_TURN_STATE_HEADER) ??
      undefined;
    codexRequest.turnMetadata =
      firstHeaderOrMetadata(c, clientMetadata, X_CODEX_TURN_METADATA_HEADER) ??
      undefined;
    codexRequest.betaFeatures =
      firstHeaderOrMetadata(c, clientMetadata, X_CODEX_BETA_FEATURES_HEADER) ??
      undefined;
    codexRequest.includeTimingMetrics =
      firstHeaderOrMetadata(c, clientMetadata, X_RESPONSESAPI_INCLUDE_TIMING_METRICS_HEADER) ??
      undefined;
    codexRequest.version = nonEmptyString(c.req.header("Version")) ?? undefined;
    codexRequest.codexWindowId =
      firstHeaderOrMetadata(c, clientMetadata, X_CODEX_WINDOW_ID_HEADER) ??
      undefined;
    codexRequest.parentThreadId =
      firstHeaderOrMetadata(c, clientMetadata, X_CODEX_PARENT_THREAD_ID_HEADER) ??
      undefined;

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

    const defaultTools = resolveDefaultTools(c, { allowUnauthenticated });
    if (defaultTools.length > 0 || (Array.isArray(body.tools) && body.tools.length > 0)) {
      const merged = mergeDefaultTools(Array.isArray(body.tools) ? (body.tools as Record<string, unknown>[]) : undefined, defaultTools);
      if (merged.length > 0) {
        codexRequest.tools = merged;
      }
    }
    if (body.tool_choice !== undefined) {
      codexRequest.tool_choice = body.tool_choice as CodexResponsesRequest["tool_choice"];
    }
    if (typeof body.parallel_tool_calls === "boolean") {
      codexRequest.parallel_tool_calls = body.parallel_tool_calls;
    }

    const expectsImageGen = Array.isArray(body.tools)
      && body.tools.some((t): t is Record<string, unknown> => isRecord(t) && t.type === "image_generation");

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
      expectsImageGen,
    };

    const requestId = c.get("requestId") ?? randomUUID().slice(0, 8);
    enqueueLogEntry({
      requestId,
      direction: "ingress",
      method: c.req.method,
      path: c.req.path,
      model: rawModel,
      stream: clientWantsStream,
      request: summarizeRequestForLog("responses", body, {
        ip: getRealClientIp(c, getConfig()?.server?.trust_proxy ?? false),
        headers: Object.fromEntries(c.req.raw.headers.entries()),
      }),
    });

    if (routeMatch?.kind === "api-key" || routeMatch?.kind === "adapter") {
      const directModel = routeMatch.resolvedModel ?? rawModel;
      const directReq = { ...proxyReq, model: directModel, codexRequest: { ...codexRequest, model: directModel } };
      return handleDirectRequest({ c, upstream: routeMatch.adapter, req: directReq, fmt: PASSTHROUGH_FORMAT });
    }

    return handleProxyRequest({ c, accountPool, cookieJar, req: proxyReq, fmt: PASSTHROUGH_FORMAT, proxyPool });
  };

  const compactHandler = async (c: Context) => {
    const rawBody = await c.req.json();

    const body = parseBody(c, rawBody);
    if (body instanceof Response) return body;

    const rawModel = typeof body.model === "string" ? body.model : "codex";

    const modelCheck = validateClientKeyModel(c, rawModel);
    if (!modelCheck.allowed) {
      c.status(403);
      return c.json({
        type: "error",
        error: {
          type: "invalid_request_error",
          code: "model_not_allowed",
          message: modelCheck.message,
          param: "model",
        },
      });
    }

    const routeMatch = upstreamRouter?.resolveMatch(rawModel);
    const allowUnauthenticated = routeMatch?.kind === "api-key" || routeMatch?.kind === "adapter";
    const authErr = checkAuth(c, accountPool, allowUnauthenticated);
    if (authErr) return authErr;

    const requestId = c.get("requestId") ?? randomUUID().slice(0, 8);
    enqueueLogEntry({
      requestId,
      direction: "ingress",
      method: c.req.method,
      path: c.req.path,
      model: rawModel,
      stream: false,
      request: summarizeRequestForLog("responses", body, {
        ip: getRealClientIp(c, getConfig()?.server?.trust_proxy ?? false),
        headers: Object.fromEntries(c.req.raw.headers.entries()),
      }),
    });

    const res = await handleCompact(c, accountPool, cookieJar, proxyPool, body, upstreamRouter);
    if (res.ok) {
      recordClientKeyUsage(c, rawModel, { input_tokens: 100, output_tokens: 100 });
    }
    return res;
  };

  app.post("/v1/responses", apiKeyAuth(accountPool, clientKeyPool), responsesHandler);
  app.post("/v1/responses/review", apiKeyAuth(accountPool, clientKeyPool), responsesHandler);
  app.post("/responses", apiKeyAuth(accountPool, clientKeyPool), responsesHandler);
  app.post("/responses/review", apiKeyAuth(accountPool, clientKeyPool), responsesHandler);
  app.post("/v1/responses/compact", apiKeyAuth(accountPool, clientKeyPool), compactHandler);

  return app;
}
