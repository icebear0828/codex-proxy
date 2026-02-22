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

/** Extract plain text from content (string, array, null, or undefined). */
function extractText(content: ChatMessage["content"]): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text!)
    .join("\n");
}

/** Flatten tool_calls array into human-readable text. */
function flattenToolCalls(
  toolCalls: NonNullable<ChatMessage["tool_calls"]>,
): string {
  return toolCalls
    .map((tc) => {
      let args = tc.function.arguments;
      try {
        args = JSON.stringify(JSON.parse(args), null, 2);
      } catch {
        /* keep raw string */
      }
      return `[Tool Call: ${tc.function.name}(${args})]`;
    })
    .join("\n");
}

/** Flatten a legacy function_call into human-readable text. */
function flattenFunctionCall(
  fc: NonNullable<ChatMessage["function_call"]>,
): string {
  let args = fc.arguments;
  try {
    args = JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    /* keep raw string */
  }
  return `[Tool Call: ${fc.name}(${args})]`;
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
  // Handles new format (tool/tool_calls) and legacy format (function/function_call)
  const input: CodexInputItem[] = [];
  for (const msg of req.messages) {
    if (msg.role === "system" || msg.role === "developer") continue;

    if (msg.role === "assistant") {
      const parts: string[] = [];
      const text = extractText(msg.content);
      if (text) parts.push(text);
      if (msg.tool_calls?.length) parts.push(flattenToolCalls(msg.tool_calls));
      if (msg.function_call) parts.push(flattenFunctionCall(msg.function_call));
      input.push({ role: "assistant", content: parts.join("\n") });
    } else if (msg.role === "tool") {
      const name = msg.name ?? msg.tool_call_id ?? "unknown";
      input.push({
        role: "user",
        content: `[Tool Result (${name})]: ${extractText(msg.content)}`,
      });
    } else if (msg.role === "function") {
      const name = msg.name ?? "unknown";
      input.push({
        role: "user",
        content: `[Tool Result (${name})]: ${extractText(msg.content)}`,
      });
    } else {
      input.push({ role: "user", content: extractText(msg.content) });
    }
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
