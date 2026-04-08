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
  tools?: unknown[];
  tool_choice?: unknown;
  thinking?: { type: "enabled"; budget_tokens: number };
}

function codexPartToAnthropic(part: CodexContentPart): AnthropicContentBlock {
  if (part.type === "input_text") {
    return { type: "text", text: part.text };
  }
  // input_image — pass as URL source
  return { type: "image", source: { type: "url", url: part.image_url } };
}

function inputItemsToAnthropicMessages(input: CodexInputItem[]): AnthropicMessage[] {
  const messages: AnthropicMessage[] = [];

  for (const item of input) {
    if ("role" in item) {
      const role = item.role;
      if (role === "system") continue; // handled via top-level system field

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

const REASONING_EFFORT_BUDGET: Record<string, number> = {
  low: 1024,
  medium: 8192,
  high: 16000,
  xhigh: 32000,
};

export function translateCodexToAnthropicRequest(
  req: CodexResponsesRequest,
  modelId: string,
): AnthropicMessageRequest {
  const messages = inputItemsToAnthropicMessages(req.input);

  const body: AnthropicMessageRequest = {
    model: modelId,
    messages,
    max_tokens: 8192,
    stream: req.stream,
  };

  if (req.instructions) {
    body.system = req.instructions;
  }

  // Thinking budget for extended reasoning
  if (req.reasoning?.effort) {
    const budget = REASONING_EFFORT_BUDGET[req.reasoning.effort] ?? 8192;
    body.thinking = { type: "enabled", budget_tokens: budget };
  }

  if (req.tools?.length) {
    body.tools = req.tools;
    if (req.tool_choice !== undefined) {
      body.tool_choice = req.tool_choice;
    }
  }

  return body;
}
