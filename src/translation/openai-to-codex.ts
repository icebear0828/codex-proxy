/**
 * Translate OpenAI Chat Completions request → Codex Responses API request.
 */

import type { ChatCompletionRequest, ChatMessage } from "../types/openai.js";
import type {
  CodexResponsesRequest,
  CodexInputItem,
  CodexContentPart,
} from "../proxy/codex-api.js";
import { parseModelName, getModelInfo } from "../models/model-store.js";
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
 * Extract content from a message, preserving images as structured content parts.
 * Returns a plain string if text-only, or CodexContentPart[] if images are present.
 */
function extractContent(
  content: ChatMessage["content"],
): string | CodexContentPart[] {
  if (content == null) return "";
  if (typeof content === "string") return content;

  const hasImage = content.some((p) => p.type === "image_url");
  if (!hasImage) {
    // Text-only: return plain string (preserves existing behavior)
    return content
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text!)
      .join("\n");
  }

  // Multimodal: convert to Codex content parts
  const parts: CodexContentPart[] = [];
  for (const p of content) {
    if (p.type === "text" && p.text) {
      parts.push({ type: "input_text", text: p.text });
    } else if (p.type === "image_url") {
      // OpenAI format: image_url: { url: "data:..." } or image_url: "string"
      const imageUrl = p.image_url as
        | string
        | { url: string; detail?: string }
        | undefined;
      if (!imageUrl) continue;
      const url = typeof imageUrl === "string" ? imageUrl : imageUrl.url;
      if (url) {
        parts.push({ type: "input_image", image_url: url });
      }
    }
  }

  return parts.length > 0 ? parts : "";
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
      input.push({ role: "user", content: extractContent(msg.content) });
    }
  }

  // Ensure at least one input message
  if (input.length === 0) {
    input.push({ role: "user", content: "" });
  }

  // Resolve model (suffix parsing extracts service_tier and reasoning_effort)
  const parsed = parseModelName(req.model);
  const modelId = parsed.modelId;
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

  // Reasoning effort: explicit API field > suffix > model default > config default
  const effort =
    req.reasoning_effort ??
    parsed.reasoningEffort ??
    modelInfo?.defaultReasoningEffort ??
    config.model.default_reasoning_effort;
  request.reasoning = { summary: "auto", ...(effort ? { effort } : {}) };

  // Service tier: explicit API field > suffix > config default
  const serviceTier =
    req.service_tier ??
    parsed.serviceTier ??
    config.model.default_service_tier ??
    null;
  if (serviceTier) {
    request.service_tier = serviceTier;
  }

  return request;
}
