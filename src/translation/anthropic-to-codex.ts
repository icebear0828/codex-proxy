/**
 * Translate Anthropic Messages API request → Codex Responses API request.
 */

import type { AnthropicMessagesRequest } from "../types/anthropic.js";
import type {
  CodexResponsesRequest,
  CodexInputItem,
  CodexContentPart,
} from "../proxy/codex-api.js";
import { resolveModelId, getModelInfo } from "../models/model-store.js";
import { getConfig } from "../config.js";
import { buildInstructions, budgetToEffort } from "./shared-utils.js";
import { anthropicToolsToCodex, anthropicToolChoiceToCodex } from "./tool-format.js";

/**
 * Map Anthropic thinking budget_tokens to Codex reasoning effort.
 */
function mapThinkingToEffort(
  thinking: AnthropicMessagesRequest["thinking"],
): string | undefined {
  if (!thinking || thinking.type === "disabled") return undefined;
  if (thinking.type === "adaptive") {
    // adaptive: use budget_tokens if provided, otherwise let Codex decide
    return thinking.budget_tokens ? budgetToEffort(thinking.budget_tokens) : undefined;
  }
  return budgetToEffort(thinking.budget_tokens);
}

/**
 * Extract text-only content from Anthropic blocks.
 */
function extractTextContent(
  content: string | Array<Record<string, unknown>>,
): string {
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

/**
 * Build multimodal content (text + images) from Anthropic blocks.
 * Returns plain string if text-only, or CodexContentPart[] if images present.
 */
function extractMultimodalContent(
  content: Array<Record<string, unknown>>,
): string | CodexContentPart[] {
  const hasImage = content.some((b) => b.type === "image");
  if (!hasImage) return extractTextContent(content);

  const parts: CodexContentPart[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push({ type: "input_text", text: block.text });
    } else if (block.type === "image") {
      // Anthropic format: source: { type: "base64", media_type: "image/png", data: "..." }
      const source = block.source as
        | { type: string; media_type: string; data: string }
        | undefined;
      if (source?.type === "base64" && source.media_type && source.data) {
        parts.push({
          type: "input_image",
          image_url: `data:${source.media_type};base64,${source.data}`,
        });
      }
    }
  }
  return parts.length > 0 ? parts : "";
}

/**
 * Convert Anthropic message content blocks into native Codex input items.
 * Handles text, image, tool_use, and tool_result blocks.
 */
function contentToInputItems(
  role: "user" | "assistant",
  content: string | Array<Record<string, unknown>>,
): CodexInputItem[] {
  if (typeof content === "string") {
    return [{ role, content }];
  }

  const items: CodexInputItem[] = [];

  // Build content (text or multimodal) for the message itself
  const hasToolBlocks = content.some((b) => b.type === "tool_use" || b.type === "tool_result");
  if (role === "user") {
    const extracted = extractMultimodalContent(content);
    if (extracted || !hasToolBlocks) {
      items.push({ role: "user", content: extracted || "" });
    }
  } else {
    // Assistant messages: text-only (Codex doesn't support structured assistant content)
    const text = extractTextContent(content);
    if (text || !hasToolBlocks) {
      items.push({ role: "assistant", content: text });
    }
  }

  for (const block of content) {
    if (block.type === "tool_use") {
      const name = typeof block.name === "string" ? block.name : "unknown";
      const id = typeof block.id === "string" ? block.id : `tc_${name}`;
      let args: string;
      try {
        args = JSON.stringify(block.input ?? {});
      } catch {
        args = "{}";
      }
      items.push({
        type: "function_call",
        call_id: id,
        name,
        arguments: args,
      });
    } else if (block.type === "tool_result") {
      const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : "unknown";
      let resultText = "";
      if (typeof block.content === "string") {
        resultText = block.content;
      } else if (Array.isArray(block.content)) {
        resultText = (block.content as Array<{ text?: string }>)
          .filter((b) => typeof b.text === "string")
          .map((b) => b.text!)
          .join("\n");
      }
      if (block.is_error) {
        resultText = `Error: ${resultText}`;
      }
      items.push({
        type: "function_call_output",
        call_id: toolUseId,
        output: resultText,
      });
    }
  }

  return items;
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
    const items = contentToInputItems(
      msg.role as "user" | "assistant",
      msg.content as string | Array<Record<string, unknown>>,
    );
    input.push(...items);
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
  const codexTools = req.tools?.length ? anthropicToolsToCodex(req.tools) : [];
  const codexToolChoice = anthropicToolChoiceToCodex(req.tool_choice);

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

  // Always request reasoning summary (translation layer filters output on demand)
  const thinkingEffort = mapThinkingToEffort(req.thinking);
  const effort =
    thinkingEffort ??
    modelInfo?.defaultReasoningEffort ??
    config.model.default_reasoning_effort;
  request.reasoning = { summary: "auto", ...(effort ? { effort } : {}) };

  return request;
}
