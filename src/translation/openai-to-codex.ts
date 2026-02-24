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
import {
  openAIToolsToCodex,
  openAIToolChoiceToCodex,
  openAIFunctionsToCodex,
} from "./tool-format.js";

/** Extract plain text from content (string, array, null, or undefined). */
function extractText(content: ChatMessage["content"]): string {
  if (content == null) return "";
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
  // Handles new format (tool/tool_calls) and legacy format (function/function_call)
  const input: CodexInputItem[] = [];
  for (const msg of req.messages) {
    if (msg.role === "system" || msg.role === "developer") continue;

    if (msg.role === "assistant") {
      // First push the text content
      const text = extractText(msg.content);
      if (text || (!msg.tool_calls?.length && !msg.function_call)) {
        input.push({ role: "assistant", content: text });
      }
      // Then push tool calls as native function_call items
      if (msg.tool_calls?.length) {
        for (const tc of msg.tool_calls) {
          input.push({
            type: "function_call",
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          });
        }
      }
      if (msg.function_call) {
        input.push({
          type: "function_call",
          call_id: `fc_${msg.function_call.name}`,
          name: msg.function_call.name,
          arguments: msg.function_call.arguments,
        });
      }
    } else if (msg.role === "tool") {
      // Native tool result
      input.push({
        type: "function_call_output",
        call_id: msg.tool_call_id ?? "unknown",
        output: extractText(msg.content),
      });
    } else if (msg.role === "function") {
      // Legacy function result → native format
      input.push({
        type: "function_call_output",
        call_id: `fc_${msg.name ?? "unknown"}`,
        output: extractText(msg.content),
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

  // Convert tools to Codex format
  const codexTools = req.tools?.length
    ? openAIToolsToCodex(req.tools)
    : req.functions?.length
      ? openAIFunctionsToCodex(req.functions)
      : [];
  const codexToolChoice = openAIToolChoiceToCodex(req.tool_choice);

  // Build request
  const request: CodexResponsesRequest = {
    model: modelId,
    instructions,
    input,
    stream: true,
    store: false,
    tools: codexTools,
  };

  // Add tool_choice if specified
  if (codexToolChoice) {
    request.tool_choice = codexToolChoice;
  }

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
