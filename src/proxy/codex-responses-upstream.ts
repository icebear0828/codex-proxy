/**
 * Responses API adapter for gateways that require official Codex client
 * context in addition to Bearer API-key authentication.
 *
 * The endpoint remains the standard `POST /responses`; this adapter uses HTTP
 * SSE and adds the same identity, context headers, and client metadata used by
 * Codex requests. It intentionally does not target ChatGPT's private
 * `/codex/responses` endpoint.
 */

import { createHash, randomUUID } from "crypto";
import { buildHeadersWithContentType } from "../fingerprint/manager.js";
import { getTransport } from "../tls/transport.js";
import { getInstallationId } from "./installation-id.js";
import { normalizeOpenAISubagent, OPENAI_SUBAGENT_HEADER } from "./openai-subagent.js";
import {
  X_CODEX_WINDOW_ID_HEADER,
  applyCodexContextHeaders,
  buildCodexClientMetadata,
  codexVersionFromUserAgent,
  firstCodexRequestString,
  nonEmptyString,
} from "./codex-request-context.js";
import { buildResponsesUpstreamBody } from "./responses-upstream.js";
import { parseSSEStream } from "./codex-sse.js";
import {
  CodexApiError,
  type CodexResponsesRequest,
  type CodexSSEEvent,
} from "./codex-types.js";
import type {
  CodexAuxiliaryJsonPath,
  CodexAuxiliaryRequestContext,
  UpstreamAdapter,
} from "./upstream-adapter.js";
import { applyResponsesLiteContract, applyResponsesLiteHeader } from "./responses-lite.js";

const MAX_ERROR_BODY = 1024 * 1024;
const CODEX_AUXILIARY_JSON_PATHS = new Set<CodexAuxiliaryJsonPath>([
  "alpha/search",
  "responses/compact",
  "images/generations",
  "images/edits",
]);

function extractModelId(model: string): string {
  const colon = model.indexOf(":");
  return colon > 0 ? model.slice(colon + 1) : model;
}

async function readErrorBody(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalSize = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalSize += value.byteLength;
    if (totalSize <= MAX_ERROR_BODY) {
      chunks.push(value);
      continue;
    }
    const overshoot = totalSize - MAX_ERROR_BODY;
    if (value.byteLength > overshoot) {
      chunks.push(value.subarray(0, value.byteLength - overshoot));
    }
    await reader.cancel();
    break;
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export class CodexResponsesUpstream implements UpstreamAdapter {
  readonly tag = "codex-responses";
  readonly baseUrl: string;

  private readonly apiKey: string;
  private readonly entryId: string;

  constructor(apiKey: string, baseUrl: string, entryId?: string | null) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.entryId = entryId ?? "anonymous-api-key-entry";
  }

  private scopedIdentity(kind: "conversation" | "window", value: string): string {
    const digest = createHash("sha256")
      .update(kind)
      .update("\0")
      .update(this.entryId)
      .update("\0")
      .update(value)
      .digest("hex")
      .slice(0, 32);
    return `${kind === "conversation" ? "cp" : "cw"}_${digest}`;
  }

  private buildIdentity(request: CodexResponsesRequest): {
    conversationId: string;
    windowId: string;
  } {
    // A caller-provided cache key gives stable per-conversation affinity.
    // Stateless callers still receive isolated Codex session/thread/window
    // context instead of omitting those client signals entirely.
    const conversationSeed = nonEmptyString(request.prompt_cache_key)
      ?? nonEmptyString(request.previous_response_id)
      ?? randomUUID();
    const conversationId = this.scopedIdentity("conversation", conversationSeed);
    const requestedWindow = firstCodexRequestString(request, X_CODEX_WINDOW_ID_HEADER);
    const windowId = requestedWindow
      ? this.scopedIdentity("window", requestedWindow)
      : `${conversationId}:0`;
    return { conversationId, windowId };
  }

  private buildClientHeaders(
    request: CodexResponsesRequest,
    accept: "application/json" | "text/event-stream",
    includeResponsesBeta: boolean,
  ): {
    headers: Record<string, string>;
    identity: { conversationId: string; windowId: string };
    installationId: string;
  } {
    const identity = this.buildIdentity(request);
    const installationId = getInstallationId();
    const headers = buildHeadersWithContentType(this.apiKey, null);

    // API-key gateways are not ChatGPT account-bound even when an API key
    // happens to be JWT-shaped.
    delete headers["ChatGPT-Account-Id"];
    headers.Accept = accept;
    if (includeResponsesBeta) {
      headers["OpenAI-Beta"] = "responses_websockets=2026-02-06";
    } else {
      delete headers["OpenAI-Beta"];
    }
    headers["x-openai-internal-codex-residency"] = "us";
    headers["x-client-request-id"] = identity.conversationId;
    headers["x-codex-installation-id"] = installationId;
    headers["session_id"] = identity.conversationId;
    headers["session-id"] = identity.conversationId;
    headers["thread_id"] = identity.conversationId;
    headers["thread-id"] = identity.conversationId;
    headers[X_CODEX_WINDOW_ID_HEADER] = identity.windowId;
    applyCodexContextHeaders(headers, request);
    applyResponsesLiteHeader(headers, request.useResponsesLite);

    // The explicit Version header must describe the same engine version as
    // the Codex User-Agent, even if the downstream caller sent another value.
    const userAgentVersion = codexVersionFromUserAgent(headers["User-Agent"]);
    if (userAgentVersion) headers.Version = userAgentVersion;
    const openAiSubagent = normalizeOpenAISubagent(
      request.client_metadata?.[OPENAI_SUBAGENT_HEADER],
    );
    if (openAiSubagent) headers[OPENAI_SUBAGENT_HEADER] = openAiSubagent;

    return { headers, identity, installationId };
  }

  async createResponse(
    request: CodexResponsesRequest,
    signal: AbortSignal,
  ): Promise<Response> {
    applyResponsesLiteContract(request);
    const { headers, identity, installationId } = this.buildClientHeaders(
      request,
      "text/event-stream",
      true,
    );

    const body = buildResponsesUpstreamBody(request, extractModelId(request.model));
    body.prompt_cache_key = identity.conversationId;
    body.client_metadata = buildCodexClientMetadata(
      request,
      installationId,
      undefined,
      identity.windowId,
    );
    if (request.previous_response_id) body.previous_response_id = request.previous_response_id;
    if (request.include?.length) body.include = request.include;

    let transportResponse;
    try {
      transportResponse = await getTransport().post(
        `${this.baseUrl}/responses`,
        headers,
        JSON.stringify(body),
        signal,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CodexApiError(0, message);
    }

    if (transportResponse.status < 200 || transportResponse.status >= 300) {
      throw new CodexApiError(
        transportResponse.status,
        await readErrorBody(transportResponse.body),
        transportResponse.headers,
      );
    }

    return new Response(transportResponse.body, {
      status: transportResponse.status,
      headers: transportResponse.headers,
    });
  }

  async forwardCodexJsonRequest(
    path: CodexAuxiliaryJsonPath,
    body: Record<string, unknown>,
    signal: AbortSignal,
    context: CodexAuxiliaryRequestContext = {},
  ): Promise<Response> {
    // Keep this runtime check even though the TypeScript union is closed: route
    // input must never become an arbitrary path appended to a configured URL.
    if (!CODEX_AUXILIARY_JSON_PATHS.has(path)) {
      throw new CodexApiError(0, `Unsupported Codex auxiliary endpoint: ${path}`);
    }

    const routedModel = typeof body.model === "string" && body.model.trim()
      ? body.model.trim()
      : "codex";
    // Provider prefixes are resolved by UpstreamRouter. Do not split on every
    // colon here: exact upstream IDs such as "google/gemma:free" are valid.
    const model = routedModel;
    const stableRequestId = typeof body.id === "string" && body.id.trim()
      ? body.id.trim()
      : undefined;
    const contextRequest: CodexResponsesRequest = {
      model,
      input: [],
      stream: true,
      store: false,
      ...context,
      ...(stableRequestId ? { prompt_cache_key: stableRequestId } : {}),
    };
    const { headers } = this.buildClientHeaders(
      contextRequest,
      "application/json",
      false,
    );

    let transportResponse;
    try {
      transportResponse = await getTransport().post(
        `${this.baseUrl}/${path}`,
        headers,
        JSON.stringify(model === body.model ? body : { ...body, model }),
        signal,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CodexApiError(0, message);
    }

    // Auxiliary endpoints use ordinary JSON rather than the Responses SSE
    // protocol. Preserve both successful and error responses for the client.
    return new Response(transportResponse.body, {
      status: transportResponse.status,
      headers: transportResponse.headers,
    });
  }

  async *parseStream(response: Response): AsyncGenerator<CodexSSEEvent> {
    yield* parseSSEStream(response);
  }
}
