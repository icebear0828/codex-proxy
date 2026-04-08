/**
 * Translate CodexResponsesRequest → OpenAI Chat Completions request body.
 *
 * Codex and OpenAI share a very similar format; most fields map 1:1.
 * The main differences:
 *   - Codex uses `instructions` (system prompt) + `input[]` (message list)
 *   - OpenAI uses `messages[]` with system messages inline
 *   - Codex function_call/function_call_output items map to assistant tool_calls + tool role
 *   - Codex `reasoning.effort` → OpenAI `reasoning_effort` (o-series models)
 */

import type { CodexInputItem, CodexContentPart, CodexResponsesRequest } from "../proxy/codex-types.js";

/** Minimal OpenAI chat message shape used for outgoing requests. */
interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | OpenAIContentPart[] | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface OpenAIContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** Outgoing OpenAI chat completions request body. */
export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  stream: boolean;
  stream_options?: { include_usage: true };
  reasoning_effort?: string;
  tools?: unknown[];
  tool_choice?: unknown;
  response_format?: unknown;
  max_completion_tokens?: number;
}

function contentPartsToOpenAI(parts: CodexContentPart[]): OpenAIContentPart[] {
  return parts.map((p) => {
    if (p.type === "input_text") return { type: "text" as const, text: p.text };
    return { type: "image_url" as const, image_url: { url: p.image_url } };
  });
}

function inputItemsToMessages(input: CodexInputItem[]): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];

  for (const item of input) {
    if ("role" in item) {
      const role = item.role as "user" | "assistant" | "system";
      const oaiRole = role === "system" ? "system" as const : role;
      if (typeof item.content === "string") {
        messages.push({ role: oaiRole, content: item.content });
      } else {
        messages.push({ role: oaiRole, content: contentPartsToOpenAI(item.content) });
      }
    } else if (item.type === "function_call") {
      // Merge consecutive function_call items into a single assistant message
      const last = messages.at(-1);
      const toolCall: OpenAIToolCall = {
        id: item.call_id,
        type: "function",
        function: { name: item.name, arguments: item.arguments },
      };
      if (last?.role === "assistant" && last.tool_calls) {
        last.tool_calls.push(toolCall);
      } else {
        messages.push({ role: "assistant", content: null, tool_calls: [toolCall] });
      }
    } else if (item.type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: item.output,
      });
    }
  }

  return messages;
}

/**
 * Build an OpenAI chat completions request body from a CodexResponsesRequest.
 * `streaming` controls whether stream_options.include_usage is added.
 */
export function translateCodexToOpenAIRequest(
  req: CodexResponsesRequest,
  modelId: string,
  streaming: boolean,
): OpenAIChatRequest {
  const messages: OpenAIMessage[] = [];

  // instructions → system message (prepended)
  if (req.instructions) {
    messages.push({ role: "system", content: req.instructions });
  }

  messages.push(...inputItemsToMessages(req.input));

  const body: OpenAIChatRequest = {
    model: modelId,
    messages,
    stream: streaming,
  };

  if (streaming) {
    body.stream_options = { include_usage: true };
  }

  // Reasoning effort (o-series models)
  if (req.reasoning?.effort) {
    body.reasoning_effort = req.reasoning.effort;
  }

  // Tools
  if (req.tools?.length) {
    body.tools = req.tools;
    if (req.tool_choice !== undefined) {
      body.tool_choice = req.tool_choice;
    }
  }

  // Response format (JSON mode / structured outputs)
  if (req.text?.format) {
    body.response_format = req.text.format;
  }

  return body;
}
