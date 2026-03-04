/**
 * Translate Google Gemini generateContent request → Codex Responses API request.
 */

import type {
  GeminiGenerateContentRequest,
  GeminiContent,
  GeminiPart,
} from "../types/gemini.js";
import type {
  CodexResponsesRequest,
  CodexInputItem,
  CodexContentPart,
} from "../proxy/codex-api.js";
import { resolveModelId, getModelInfo } from "../models/model-store.js";
import { getConfig } from "../config.js";
import { buildInstructions, budgetToEffort } from "./shared-utils.js";
import { geminiToolsToCodex, geminiToolConfigToCodex } from "./tool-format.js";

/**
 * Extract text-only content from Gemini parts.
 */
function extractTextFromParts(parts: GeminiPart[]): string {
  return parts
    .filter((p) => !p.thought && p.text)
    .map((p) => p.text!)
    .join("\n");
}

/**
 * Build multimodal content (text + images) from Gemini parts.
 * Returns plain string if text-only, or CodexContentPart[] if images present.
 */
function extractMultimodalFromParts(
  parts: GeminiPart[],
): string | CodexContentPart[] {
  const hasImage = parts.some((p) => p.inlineData);
  if (!hasImage) return extractTextFromParts(parts);

  const codexParts: CodexContentPart[] = [];
  for (const p of parts) {
    if (!p.thought && p.text) {
      codexParts.push({ type: "input_text", text: p.text });
    } else if (p.inlineData) {
      codexParts.push({
        type: "input_image",
        image_url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}`,
      });
    }
  }
  return codexParts.length > 0 ? codexParts : "";
}

/**
 * Convert Gemini content parts into native Codex input items.
 */
function partsToInputItems(
  role: "user" | "assistant",
  parts: GeminiPart[],
): CodexInputItem[] {
  const items: CodexInputItem[] = [];
  const hasFunctionParts = parts.some((p) => p.functionCall || p.functionResponse);

  // Build content — multimodal for user, text-only for assistant
  if (role === "user") {
    const content = extractMultimodalFromParts(parts);
    if (content || !hasFunctionParts) {
      items.push({ role: "user", content: content || "" });
    }
  } else {
    const text = extractTextFromParts(parts);
    if (text || !hasFunctionParts) {
      items.push({ role: "assistant", content: text });
    }
  }

  // Track call_ids by function name to correlate functionCall → functionResponse
  let callCounter = 0;
  const nameToCallIds = new Map<string, string[]>();

  for (const p of parts) {
    if (p.functionCall) {
      const callId = `fc_${callCounter++}`;
      let args: string;
      try {
        args = JSON.stringify(p.functionCall.args ?? {});
      } catch {
        args = "{}";
      }
      items.push({
        type: "function_call",
        call_id: callId,
        name: p.functionCall.name,
        arguments: args,
      });
      // Record call_id for this function name (for matching responses)
      const ids = nameToCallIds.get(p.functionCall.name) ?? [];
      ids.push(callId);
      nameToCallIds.set(p.functionCall.name, ids);
    } else if (p.functionResponse) {
      let output: string;
      try {
        output = JSON.stringify(p.functionResponse.response ?? {});
      } catch {
        output = String(p.functionResponse.response);
      }
      // Match response to the earliest unmatched call with the same name
      const ids = nameToCallIds.get(p.functionResponse.name);
      const callId = ids?.shift() ?? `fc_${callCounter++}`;
      items.push({
        type: "function_call_output",
        call_id: callId,
        output,
      });
    }
  }

  return items;
}

/**
 * Extract text from Gemini content parts (for session hashing).
 */
function flattenParts(parts: GeminiPart[]): string {
  return extractTextFromParts(parts);
}

/**
 * Convert Gemini contents to SessionManager-compatible message format.
 */
export function geminiContentsToMessages(
  contents: GeminiContent[],
  systemInstruction?: GeminiContent,
): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = [];

  if (systemInstruction) {
    messages.push({
      role: "system",
      content: flattenParts(systemInstruction.parts),
    });
  }

  for (const c of contents) {
    const role = c.role === "model" ? "assistant" : c.role ?? "user";
    messages.push({ role, content: flattenParts(c.parts) });
  }

  return messages;
}

/**
 * Convert a GeminiGenerateContentRequest to a CodexResponsesRequest.
 *
 * Mapping:
 *   - systemInstruction → instructions field
 *   - contents → input array (role: "model" → "assistant")
 *   - model (from URL) → resolved model ID
 *   - thinkingConfig → reasoning.effort
 */
export function translateGeminiToCodexRequest(
  req: GeminiGenerateContentRequest,
  geminiModel: string,
  previousResponseId?: string | null,
): CodexResponsesRequest {
  // Extract system instructions
  let userInstructions: string;
  if (req.systemInstruction) {
    userInstructions = flattenParts(req.systemInstruction.parts);
  } else {
    userInstructions = "You are a helpful assistant.";
  }
  const instructions = buildInstructions(userInstructions);

  // Build input items from contents
  const input: CodexInputItem[] = [];
  for (const content of req.contents) {
    const role = content.role === "model" ? "assistant" : "user";
    const items = partsToInputItems(
      role as "user" | "assistant",
      content.parts as GeminiPart[],
    );
    input.push(...items);
  }

  // Ensure at least one input message
  if (input.length === 0) {
    input.push({ role: "user", content: "" });
  }

  // Resolve model
  const modelId = resolveModelId(geminiModel);
  const modelInfo = getModelInfo(modelId);
  const config = getConfig();

  // Convert tools to Codex format
  const codexTools = req.tools?.length ? geminiToolsToCodex(req.tools) : [];
  const codexToolChoice = geminiToolConfigToCodex(req.toolConfig);

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
  const thinkingEffort = budgetToEffort(
    req.generationConfig?.thinkingConfig?.thinkingBudget,
  );
  const effort =
    thinkingEffort ??
    modelInfo?.defaultReasoningEffort ??
    config.model.default_reasoning_effort;
  request.reasoning = { summary: "auto", ...(effort ? { effort } : {}) };

  return request;
}
