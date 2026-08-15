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
import type { UpstreamAdapter } from "./upstream-adapter.js";

const MAX_ERROR_BODY = 1024 * 1024;

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

  async createResponse(
    request: CodexResponsesRequest,
    signal: AbortSignal,
  ): Promise<Response> {
    const identity = this.buildIdentity(request);
    const installationId = getInstallationId();
    const headers = buildHeadersWithContentType(this.apiKey, null);

    // API-key gateways are not ChatGPT account-bound even when an API key
    // happens to be JWT-shaped.
    delete headers["ChatGPT-Account-Id"];
    headers.Accept = "text/event-stream";
    headers["OpenAI-Beta"] = "responses_websockets=2026-02-06";
    headers["x-openai-internal-codex-residency"] = "us";
    headers["x-client-request-id"] = identity.conversationId;
    headers["x-codex-installation-id"] = installationId;
    headers["session-id"] = identity.conversationId;
    headers["thread-id"] = identity.conversationId;
    headers[X_CODEX_WINDOW_ID_HEADER] = identity.windowId;
    applyCodexContextHeaders(headers, request);

    // The explicit Version header must describe the same engine version as
    // the Codex User-Agent, even if the downstream caller sent another value.
    const userAgentVersion = codexVersionFromUserAgent(headers["User-Agent"]);
    if (userAgentVersion) headers.Version = userAgentVersion;
    const openAiSubagent = normalizeOpenAISubagent(
      request.client_metadata?.[OPENAI_SUBAGENT_HEADER],
    );
    if (openAiSubagent) headers[OPENAI_SUBAGENT_HEADER] = openAiSubagent;

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

  async *parseStream(response: Response): AsyncGenerator<CodexSSEEvent> {
    yield* parseSSEStream(response);
  }
}
