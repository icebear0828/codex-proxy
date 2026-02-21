/**
 * Translate Anthropic Messages API request → Codex Responses API request.
 */

import type { AnthropicMessagesRequest } from "../types/anthropic.js";
import type {
  CodexResponsesRequest,
  CodexInputItem,
} from "../proxy/codex-api.js";
import { resolveModelId, getModelInfo } from "../routes/models.js";
import { getConfig } from "../config.js";
import { buildInstructions, budgetToEffort } from "./shared-utils.js";

/**
 * Map Anthropic thinking budget_tokens to Codex reasoning effort.
 */
function mapThinkingToEffort(
  thinking: AnthropicMessagesRequest["thinking"],
): string | undefined {
  if (!thinking || thinking.type === "disabled") return undefined;
  return budgetToEffort(thinking.budget_tokens);
}

/**
 * Extract text from Anthropic content (string or content block array).
 */
function flattenContent(
  content: string | Array<{ type: string; text?: string }>,
): string {
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!)
    .join("\n");
}

/**
 * Convert an AnthropicMessagesRequest to a CodexResponsesRequest.
 *
 * Mapping:
 *   - system (top-level) → instructions field
 *   - messages → input array
 *   - model → resolved model ID
 *   - thinking → reasoning.effort
 */
export function translateAnthropicToCodexRequest(
  req: AnthropicMessagesRequest,
  previousResponseId?: string | null,
): CodexResponsesRequest {
  // Extract system instructions
  let userInstructions: string;
  if (req.system) {
    if (typeof req.system === "string") {
      userInstructions = req.system;
    } else {
      userInstructions = req.system.map((b) => b.text).join("\n\n");
    }
  } else {
    userInstructions = "You are a helpful assistant.";
  }
  const instructions = buildInstructions(userInstructions);

  // Build input items from messages
  const input: CodexInputItem[] = [];
  for (const msg of req.messages) {
    input.push({
      role: msg.role as "user" | "assistant",
      content: flattenContent(msg.content),
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

  // Add reasoning effort: thinking param → model default → config default
  const thinkingEffort = mapThinkingToEffort(req.thinking);
  const effort =
    thinkingEffort ??
    modelInfo?.defaultReasoningEffort ??
    config.model.default_reasoning_effort;
  if (effort) {
    request.reasoning = { effort };
  }

  return request;
}
