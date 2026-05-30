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
 * Build the upstream `/responses` body from the internal request, rewriting the
 * model to the provider-native id.
 *
 * This is an ALLOWLIST, not a denylist: only standard Responses API generation
 * fields are forwarded. Everything else is intentionally dropped so nothing
 * codex-proxy-internal ever leaks to an arbitrary third-party endpoint —
 * routing fields (useWebSocket / turnState / …), chatgpt.com-scoped state
 * (client_metadata), and the OpenAI-org-bound `include:
 * ["reasoning.encrypted_content"]` (most likely to be rejected by, or
 * meaningless to, a non-OpenAI provider; reasoning summaries still stream
 * without it).
 *
 * Known limitation: `previous_response_id` is dropped, so server-side
 * conversation continuation is not supported on third-party Responses backends.
 * codex-proxy keeps no session affinity for direct upstreams, and the id is a
 * chatgpt.com-scoped `resp_*` the third party cannot resolve (passing it through
 * would guarantee a 404). This matches the Chat Completions wire, which has no
 * continuation concept either.
 */
export function buildResponsesUpstreamBody(
  req: CodexResponsesRequest,
  modelId: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: modelId,
    input: req.input,
    stream: req.stream,
    store: req.store, // keep false — third parties must not retain proxied data
  };
  if (req.instructions != null) body.instructions = req.instructions;
  if (req.reasoning !== undefined) body.reasoning = req.reasoning;
  if (req.tools !== undefined) body.tools = req.tools;
  if (req.tool_choice !== undefined) body.tool_choice = req.tool_choice;
  if (req.parallel_tool_calls !== undefined) body.parallel_tool_calls = req.parallel_tool_calls;
  if (req.text !== undefined) body.text = req.text;
  if (req.prompt_cache_key !== undefined) body.prompt_cache_key = req.prompt_cache_key;

  const tier = normalizeServiceTier(req.service_tier);
  if (tier) body.service_tier = tier;

  return body;
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
