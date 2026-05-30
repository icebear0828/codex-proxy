/**
 * ResponsesUpstream — UpstreamAdapter for OpenAI-compatible providers that
 * speak the native Responses API (`POST /responses`) rather than Chat
 * Completions.
 *
 * codex-proxy's internal request representation is already Responses-shaped,
 * so this adapter is near-passthrough: createResponse() forwards the request
 * (stripped of codex-proxy-internal routing fields) and parseStream() emits the
 * native Responses SSE events as-is — they are already in CodexSSEEvent shape.
 *
 * Opt-in per API key via `ApiKeyEntry.wire = "responses"`. Default stays
 * Chat Completions (OpenAIUpstream) because the common third-party providers
 * (DeepSeek / Kimi / GLM) only expose /chat/completions.
 */

import type { UpstreamAdapter } from "./upstream-adapter.js";
import type { CodexResponsesRequest, CodexSSEEvent } from "./codex-types.js";
import { CodexApiError } from "./codex-types.js";
import { parseSSEStream } from "./codex-sse.js";
import { withFetchDispatcher } from "./fetch-dispatcher.js";

function extractModelId(model: string): string {
  const colon = model.indexOf(":");
  return colon > 0 ? model.slice(colon + 1) : model;
}

/** Codex uses "fast" for priority routing; the public Responses API calls it "priority". */
function normalizeServiceTier(serviceTier: string | null | undefined): string | undefined {
  if (!serviceTier) return undefined;
  return serviceTier === "fast" ? "priority" : serviceTier;
}

/**
 * Strip codex-proxy-internal / chatgpt.com-only fields and rewrite the model to
 * the provider-native id. The remaining shape is a standard Responses request.
 */
export function buildResponsesUpstreamBody(
  req: CodexResponsesRequest,
  modelId: string,
): Record<string, unknown> {
  const {
    previous_response_id: _pid,
    client_metadata: _cm,
    useWebSocket: _ws,
    turnState: _ts,
    turnMetadata: _tm,
    betaFeatures: _bf,
    version: _ver,
    includeTimingMetrics: _timing,
    codexWindowId: _window,
    parentThreadId: _parent,
    service_tier,
    ...rest
  } = req;

  const tier = normalizeServiceTier(service_tier);
  return {
    ...rest,
    model: modelId,
    ...(tier ? { service_tier: tier } : {}),
  };
}

export class ResponsesUpstream implements UpstreamAdapter {
  readonly tag: string;
  private apiKey: string;
  private baseUrl: string;

  constructor(tag: string, apiKey: string, baseUrl = "https://api.openai.com/v1") {
    this.tag = tag;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async createResponse(
    req: CodexResponsesRequest,
    signal: AbortSignal,
  ): Promise<Response> {
    const modelId = extractModelId(req.model);
    const body = buildResponsesUpstreamBody(req, modelId);

    const response = await fetch(`${this.baseUrl}/responses`, withFetchDispatcher({
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
      },
      body: JSON.stringify(body),
      signal,
    }));

    if (!response.ok) {
      const errorText = await response.text().catch(() => `HTTP ${response.status}`);
      throw new CodexApiError(response.status, errorText);
    }

    return response;
  }

  async *parseStream(response: Response): AsyncGenerator<CodexSSEEvent> {
    // Native Responses SSE is already in CodexSSEEvent shape ({ event, data }).
    yield* parseSSEStream(response);
  }
}
