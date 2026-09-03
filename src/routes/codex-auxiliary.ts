/** Exact, non-streaming Codex client endpoint passthrough for API-key wires. */

import { randomUUID } from "crypto";
import type { Context } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import { enqueueLogEntry } from "../logs/entry.js";
import { CodexApiError } from "../proxy/codex-types.js";
import type { CodexAuxiliaryJsonPath, UpstreamAdapter } from "../proxy/upstream-adapter.js";
import type { CodexAuxiliaryRequestContext } from "../proxy/upstream-adapter.js";
import {
  X_CODEX_BETA_FEATURES_HEADER,
  X_CODEX_PARENT_THREAD_ID_HEADER,
  X_CODEX_TURN_METADATA_HEADER,
  X_CODEX_WINDOW_ID_HEADER,
  X_RESPONSESAPI_INCLUDE_TIMING_METRICS_HEADER,
} from "../proxy/codex-request-context.js";
import { OPENAI_SUBAGENT_HEADER, sanitizeClientMetadata } from "../proxy/openai-subagent.js";
import {
  isResponsesLiteRequest,
  RESPONSES_LITE_HEADER,
  WS_RESPONSES_LITE_METADATA_KEY,
} from "../proxy/responses-lite.js";

const NO_BODY_STATUSES = new Set([204, 205, 304]);
const SAFE_RESPONSE_HEADERS = new Set([
  "cache-control",
  "content-language",
  "content-type",
  "etag",
  "last-modified",
  "location",
  "openai-processing-ms",
  "openai-version",
  "request-id",
  "retry-after",
  "traceparent",
  "tracestate",
  "x-openai-processing-ms",
  "x-openai-request-id",
  "x-request-id",
]);
const SAFE_RESPONSE_HEADER_PREFIXES = ["ratelimit-", "x-ratelimit-"];

export interface HandleCodexAuxiliaryJsonOptions {
  c: Context;
  upstream: UpstreamAdapter & Required<Pick<UpstreamAdapter, "forwardCodexJsonRequest">>;
  path: CodexAuxiliaryJsonPath;
  body: Record<string, unknown>;
  model: string;
}

export function codexAuxiliaryResponseHeaders(upstreamHeaders: Headers): Headers {
  const headers = new Headers();
  upstreamHeaders.forEach((value, name) => {
    const normalized = name.toLowerCase();
    if (
      SAFE_RESPONSE_HEADERS.has(normalized)
      || SAFE_RESPONSE_HEADER_PREFIXES.some((prefix) => normalized.startsWith(prefix))
    ) {
      headers.append(name, value);
    }
  });
  return headers;
}

function errorResponse(c: Context, status: number, message: string): Response {
  const code = (status >= 400 && status <= 599 ? status : 502) as StatusCode;
  c.status(code);
  return c.json({
    error: {
      message,
      type: "server_error",
      code: "codex_auxiliary_upstream_error",
    },
  });
}

function nonEmptyHeader(c: Context, name: string): string | undefined {
  const value = c.req.header(name)?.trim();
  return value || undefined;
}

export function codexAuxiliaryRequestContext(
  c: Context,
  body?: Record<string, unknown>,
  supportsResponsesLite = false,
): CodexAuxiliaryRequestContext {
  const openAiSubagent = nonEmptyHeader(c, OPENAI_SUBAGENT_HEADER);
  const wsLiteMarker = nonEmptyHeader(c, WS_RESPONSES_LITE_METADATA_KEY);
  const clientMetadata = {
    ...sanitizeClientMetadata(body?.client_metadata),
    ...(openAiSubagent ? { [OPENAI_SUBAGENT_HEADER]: openAiSubagent } : {}),
    ...(wsLiteMarker ? { [WS_RESPONSES_LITE_METADATA_KEY]: wsLiteMarker } : {}),
  };
  return {
    turnState: nonEmptyHeader(c, "x-codex-turn-state"),
    turnMetadata: nonEmptyHeader(c, X_CODEX_TURN_METADATA_HEADER),
    betaFeatures: nonEmptyHeader(c, X_CODEX_BETA_FEATURES_HEADER),
    version: nonEmptyHeader(c, "Version"),
    includeTimingMetrics: nonEmptyHeader(c, X_RESPONSESAPI_INCLUDE_TIMING_METRICS_HEADER),
    codexWindowId: nonEmptyHeader(c, X_CODEX_WINDOW_ID_HEADER),
    parentThreadId: nonEmptyHeader(c, X_CODEX_PARENT_THREAD_ID_HEADER),
    useResponsesLite: supportsResponsesLite
      && isResponsesLiteRequest(nonEmptyHeader(c, RESPONSES_LITE_HEADER), clientMetadata),
    ...(Object.keys(clientMetadata).length > 0 ? { client_metadata: clientMetadata } : {}),
  };
}

export async function handleCodexAuxiliaryJson(
  options: HandleCodexAuxiliaryJsonOptions,
): Promise<Response> {
  const { c, upstream, path, body, model } = options;
  const requestId = c.get("requestId") ?? randomUUID().slice(0, 8);
  const startMs = Date.now();

  let rawResponse: Response;
  try {
    rawResponse = await upstream.forwardCodexJsonRequest(
      path,
      body,
      c.req.raw.signal,
      codexAuxiliaryRequestContext(c, body, path === "responses/compact"),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upstream request failed";
    const status = error instanceof CodexApiError && error.status >= 400
      ? error.status
      : 502;
    enqueueLogEntry({
      requestId,
      direction: "egress",
      method: "POST",
      path: `/v1/${path}`,
      model,
      provider: upstream.tag,
      status,
      latencyMs: Date.now() - startMs,
      stream: false,
      error: message,
      request: { model, endpoint: path },
    });
    return errorResponse(c, status, message);
  }

  enqueueLogEntry({
    requestId,
    direction: "egress",
    method: "POST",
    path: `/v1/${path}`,
    model,
    provider: upstream.tag,
    status: rawResponse.status,
    latencyMs: Date.now() - startMs,
    stream: false,
    request: { model, endpoint: path },
  });

  return new Response(
    NO_BODY_STATUSES.has(rawResponse.status) ? null : rawResponse.body,
    {
      status: rawResponse.status,
      statusText: rawResponse.statusText,
      headers: codexAuxiliaryResponseHeaders(rawResponse.headers),
    },
  );
}
