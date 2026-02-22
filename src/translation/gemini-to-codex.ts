/**
 * Translate Google Gemini generateContent request → Codex Responses API request.
 */

import type {
  GeminiGenerateContentRequest,
  GeminiContent,
} from "../types/gemini.js";
import type {
  CodexResponsesRequest,
  CodexInputItem,
} from "../proxy/codex-api.js";
import { resolveModelId, getModelInfo } from "../routes/models.js";
import { getConfig } from "../config.js";
import { buildInstructions, budgetToEffort } from "./shared-utils.js";

/**
 * Extract text from Gemini content parts.
 * Flattens functionCall/functionResponse parts into readable text for Codex.
 */
function flattenParts(
  parts: Array<{
    text?: string;
    thought?: boolean;
    functionCall?: { name: string; args?: Record<string, unknown> };
    functionResponse?: { name: string; response?: Record<string, unknown> };
  }>,
): string {
  const textParts: string[] = [];
  for (const p of parts) {
    if (p.thought) continue;
    if (p.text) {
      textParts.push(p.text);
    } else if (p.functionCall) {
      let args: string;
      try {
        args = JSON.stringify(p.functionCall.args ?? {}, null, 2);
      } catch {
        args = String(p.functionCall.args);
      }
      textParts.push(`[Tool Call: ${p.functionCall.name}(${args})]`);
    } else if (p.functionResponse) {
      let resp: string;
      try {
        resp = JSON.stringify(p.functionResponse.response ?? {}, null, 2);
      } catch {
        resp = String(p.functionResponse.response);
      }
      textParts.push(`[Tool Result (${p.functionResponse.name})]: ${resp}`);
    }
  }
  return textParts.join("\n");
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
    input.push({
      role: role as "user" | "assistant",
      content: flattenParts(content.parts),
    });
  }

  // Ensure at least one input message
  if (input.length === 0) {
    input.push({ role: "user", content: "" });
  }

  // Resolve model
  const modelId = resolveModelId(geminiModel);
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

  // Add reasoning effort: thinkingBudget → model default → config default
  const thinkingEffort = budgetToEffort(
    req.generationConfig?.thinkingConfig?.thinkingBudget,
  );
  const effort =
    thinkingEffort ??
    modelInfo?.defaultReasoningEffort ??
    config.model.default_reasoning_effort;
  if (effort) {
    request.reasoning = { effort };
  }

  return request;
}
