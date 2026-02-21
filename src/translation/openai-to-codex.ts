/**
 * Translate OpenAI Chat Completions request → Codex Responses API request.
 */

import type { ChatCompletionRequest } from "../types/openai.js";
import type {
  CodexResponsesRequest,
  CodexInputItem,
} from "../proxy/codex-api.js";
import { resolveModelId, getModelInfo } from "../routes/models.js";
import { getConfig } from "../config.js";
import { buildInstructions } from "./shared-utils.js";

/**
 * Convert a ChatCompletionRequest to a CodexResponsesRequest.
 *
 * Mapping:
 *   - system messages → instructions field
 *   - user/assistant messages → input array
 *   - model → resolved model ID
 *   - reasoning_effort → reasoning.effort
 */
export function translateToCodexRequest(
  req: ChatCompletionRequest,
  previousResponseId?: string | null,
): CodexResponsesRequest {
  // Collect system messages as instructions
  const systemMessages = req.messages.filter((m) => m.role === "system");
  const userInstructions =
    systemMessages.map((m) => m.content).join("\n\n") ||
    "You are a helpful assistant.";
  const instructions = buildInstructions(userInstructions);

  // Build input items from non-system messages
  const input: CodexInputItem[] = [];
  for (const msg of req.messages) {
    if (msg.role === "system") continue;
    input.push({
      role: msg.role as "user" | "assistant",
      content: msg.content,
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
