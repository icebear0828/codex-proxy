/**
 * Translate CodexResponsesRequest → Anthropic Messages API request body.
 *
 * Key differences from Codex/OpenAI:
 *   - System prompt is a top-level `system` field (not inline message)
 *   - Tool call results use `tool_result` content type (not `role: "tool"`)
 *   - Tool calls in assistant turns use `tool_use` content type
 *   - `thinking` budget maps to extended thinking params
 *   - Images use `source` with base64 or URL (different from OpenAI)
 */

import type { CodexInputItem, CodexContentPart, CodexResponsesRequest } from "../proxy/codex-types.js";
import { isRecord, REASONING_EFFORT_BUDGET } from "./shared-utils.js";

/** Anthropic content block shapes. */
type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "url"; url: string } | { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicMessageRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string;
  max_tokens: number;
  stream: boolean;
  tools?: Array<{ name: string; description?: string; input_schema: Record<string, unknown> }>;
  tool_choice?: { type: "auto" | "none" | "any" } | { type: "tool"; name: string };
  thinking?: { type: "enabled"; budget_tokens: number };
}

function codexPartToAnthropic(part: CodexContentPart): AnthropicContentBlock {
  if (part.type === "input_text") {
    return { type: "text", text: part.text };
  }
  const dataUri = /^data:([^;,]+);base64,(.+)$/s.exec(part.image_url);
  if (dataUri) {
    return { type: "image", source: { type: "base64", media_type: dataUri[1], data: dataUri[2] } };
  }
  return { type: "image", source: { type: "url", url: part.image_url } };
}

function codexToolsToAnthropic(tools: unknown[]): NonNullable<AnthropicMessageRequest["tools"]> {
  return tools.map((tool) => {
    if (!isRecord(tool) || tool.type !== "function" || typeof tool.name !== "string") {
      throw new TypeError("Anthropic upstream only supports Codex function tools");
    }
    const converted: NonNullable<AnthropicMessageRequest["tools"]>[number] = {
      name: tool.name,
      input_schema: isRecord(tool.parameters) ? tool.parameters : { type: "object", properties: {} },
    };
    if (typeof tool.description === "string") converted.description = tool.description;
    return converted;
  });
}

function codexToolChoiceToAnthropic(
  choice: CodexResponsesRequest["tool_choice"],
): AnthropicMessageRequest["tool_choice"] {
  if (choice === "auto" || choice === "none") return { type: choice };
  if (choice === "required") return { type: "any" };
  if (choice && typeof choice === "object" && choice.type === "function" && typeof choice.name === "string") {
    return { type: "tool", name: choice.name };
  }
  if (choice !== undefined) throw new TypeError("Unsupported Codex tool choice for Anthropic upstream");
  return undefined;
}

function inputItemsToAnthropicMessages(input: CodexInputItem[]): AnthropicMessage[] {
  const messages: AnthropicMessage[] = [];

  for (const item of input) {
    if ("role" in item) {
      const role = item.role;
      if (role === "system" || role === "developer") continue; // handled via top-level system field

      const oaiRole = role as "user" | "assistant";
      if (typeof item.content === "string") {
        messages.push({ role: oaiRole, content: item.content });
      } else {
        messages.push({ role: oaiRole, content: item.content.map(codexPartToAnthropic) });
      }
    } else if (item.type === "function_call") {
      // Merge into preceding assistant message or create new one
      const toolUse: AnthropicContentBlock = {
        type: "tool_use",
        id: item.call_id,
        name: item.name,
        input: (() => {
          try { return JSON.parse(item.arguments) as unknown; } catch { return {}; }
        })(),
      };
      const last = messages.at(-1);
      if (last?.role === "assistant" && Array.isArray(last.content)) {
        last.content.push(toolUse);
      } else {
        messages.push({ role: "assistant", content: [toolUse] });
      }
    } else if (item.type === "function_call_output") {
      const toolResult: AnthropicContentBlock = {
        type: "tool_result",
        tool_use_id: item.call_id,
        content: item.output,
      };
      // tool_result must be inside a user message
      const last = messages.at(-1);
      if (last?.role === "user" && Array.isArray(last.content)) {
        last.content.push(toolResult);
      } else {
        messages.push({ role: "user", content: [toolResult] });
      }
    }
  }

  return messages;
}


export function translateCodexToAnthropicRequest(
  req: CodexResponsesRequest,
  modelId: string,
): AnthropicMessageRequest {
  const systemInstructions: string[] = [];
  if (req.instructions) {
    systemInstructions.push(req.instructions);
  }

  // Find additional system/developer instructions in input to merge into system field
  for (const item of req.input) {
    if ("role" in item && (item.role === "system" || item.role === "developer")) {
      if (typeof item.content === "string" && item.content.trim()) {
        systemInstructions.push(item.content.trim());
      }
    }
  }

  const messages = inputItemsToAnthropicMessages(req.input);

  const body: AnthropicMessageRequest = {
    model: modelId,
    messages,
    max_tokens: 8192,
    stream: req.stream,
  };

  if (systemInstructions.length > 0) {
    body.system = systemInstructions.join("\n\n");
  }

  // Thinking budget for extended reasoning
  if (req.reasoning?.effort) {
    const budget = REASONING_EFFORT_BUDGET[req.reasoning.effort] ?? 8192;
    body.thinking = { type: "enabled", budget_tokens: budget };
  }

  if (req.tools?.length) {
    const tools = codexToolsToAnthropic(req.tools);
    body.tools = tools;
    body.tool_choice = codexToolChoiceToAnthropic(req.tool_choice);
  }

  return body;
}
