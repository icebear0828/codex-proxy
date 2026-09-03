import type {
  CodexCompactRequest,
  CodexReasoningContext,
  CodexResponsesRequest,
} from "./codex-types.js";

export const RESPONSES_LITE_HEADER = "x-openai-internal-codex-responses-lite";
export const WS_RESPONSES_LITE_METADATA_KEY =
  "ws_request_header_x_openai_internal_codex_responses_lite";

const REASONING_CONTEXTS = new Set<CodexReasoningContext>([
  "auto",
  "current_turn",
  "all_turns",
]);

export function parseReasoningContext(value: unknown): CodexReasoningContext | undefined {
  return typeof value === "string" && REASONING_CONTEXTS.has(value as CodexReasoningContext)
    ? value as CodexReasoningContext
    : undefined;
}

function isTrue(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "true";
}

export function isResponsesLiteRequest(
  headerValue: string | undefined,
  clientMetadata: Record<string, string>,
): boolean {
  return isTrue(headerValue) || isTrue(clientMetadata[WS_RESPONSES_LITE_METADATA_KEY]);
}

export function applyResponsesLiteContract(
  request: CodexResponsesRequest | CodexCompactRequest,
): void {
  if (!request.useResponsesLite) return;
  request.reasoning = { ...(request.reasoning ?? {}), context: "all_turns" };
  request.parallel_tool_calls = false;
}

export function responsesLiteBody(
  body: Record<string, unknown>,
  enabled: boolean,
): Record<string, unknown> {
  if (!enabled) return body;
  const reasoning = typeof body.reasoning === "object"
    && body.reasoning !== null
    && !Array.isArray(body.reasoning)
    ? body.reasoning as Record<string, unknown>
    : {};
  return {
    ...body,
    reasoning: { ...reasoning, context: "all_turns" },
    parallel_tool_calls: false,
  };
}

export function applyResponsesLiteHeader(
  headers: Record<string, string>,
  enabled: boolean | undefined,
): void {
  if (enabled) headers[RESPONSES_LITE_HEADER] = "true";
}

export function applyResponsesLiteWsMetadata(
  metadata: Record<string, string>,
  enabled: boolean | undefined,
): void {
  if (enabled) metadata[WS_RESPONSES_LITE_METADATA_KEY] = "true";
}
