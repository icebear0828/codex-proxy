/**
 * Translate OpenAI Chat Completions request → Codex Responses API request.
 */

import type { ChatCompletionRequest, ChatMessage } from "../types/openai.js";
import type {
  CodexResponsesRequest,
  CodexInputItem,
} from "../proxy/codex-api.js";
import { resolveModelId, getModelInfo } from "../routes/models.js";
import { getConfig } from "../config.js";
import { buildInstructions } from "./shared-utils.js";

/** Extract plain text from content (string or array of content parts). */
function extractText(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text!)
    .join("\n");
}

/**
 * Convert a ChatCompletionRequest to a CodexResponsesRequest.
 *
 * Mapping:
 *   - system/developer messages → instructions field
 *   - user/assistant messages → input array
 *   - model → resolved model ID
 *   - reasoning_effort → reasoning.effort
 */
export function translateToCodexRequest(
  req: ChatCompletionRequest,
  previousResponseId?: string | null,
): CodexResponsesRequest {
  // Collect system/developer messages as instructions
  const systemMessages = req.messages.filter(
    (m) => m.role === "system" || m.role === "developer",
  );
  const userInstructions =
    systemMessages.map((m) => extractText(m.content)).join("\n\n") ||
    "You are a helpful assistant.";
  const instructions = buildInstructions(userInstructions);

  // Build input items from non-system messages
  const input: CodexInputItem[] = [];
  for (const msg of req.messages) {
    if (msg.role === "system" || msg.role === "developer") continue;
    input.push({
      role: msg.role as "user" | "assistant",
      content: extractText(msg.content),
    });
  }

  // Ensure at least one input message
  if (input.length === 0) {
    input.push({ role: "user", content: "" });
  }

  // Resolve model
  const modelId = resolveModelId(req.model);
  const modelInfo = getModelInfo(modelId);
  const config = getConfig();

  // Build request
  const request: CodexResponsesRequest = {
    model: modelId,
    instructions,
    input,
    stream: true,
    store: false,
    tools: [],
  };

  // Add previous response ID for multi-turn conversations
  if (previousResponseId) {
    request.previous_response_id = previousResponseId;
  }

  // Add reasoning effort if applicable
  const effort =
    req.reasoning_effort ??
    modelInfo?.defaultReasoningEffort ??
    config.model.default_reasoning_effort;
  if (effort) {
    request.reasoning = { effort };
  }

  return request;
}
