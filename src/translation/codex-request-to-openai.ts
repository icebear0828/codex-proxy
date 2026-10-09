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
import { CodexApiError } from "../proxy/codex-types.js";
import { isRecord } from "./shared-utils.js";

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
  type: "function" | "custom";
  function?: { name: string; arguments: string };
  custom?: { name: string; input: string };
}

interface OpenAIFunctionTool {
  type: "function";
  function: { name: string; description?: string; parameters?: Record<string, unknown>; strict?: boolean };
}

interface OpenAICustomTool {
  type: "custom";
  name: string;
  description?: string;
  format?: Record<string, unknown>;
}

/** Outgoing OpenAI chat completions request body. */
export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  stream: boolean;
  stream_options?: { include_usage: true };
  reasoning_effort?: string;
  tools?: Array<OpenAIFunctionTool | OpenAICustomTool>;
  tool_choice?: string | { type: "function"; function: { name: string } } | { type: "custom"; name: string };
  parallel_tool_calls?: boolean;
  web_search_options?: { search_context_size?: "low" | "medium" | "high"; user_location?: Record<string, unknown> };
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
      const role = item.role;
      const oaiRole = (role === "system" || role === "developer") ? "system" as const : role as "user" | "assistant";
      if (typeof item.content === "string") {
        messages.push({ role: oaiRole, content: item.content });
      } else {
        messages.push({ role: oaiRole, content: contentPartsToOpenAI(item.content) });
      }
    } else if (item.type === "function_call" || item.type === "custom_tool_call") {
      const last = messages.at(-1);
      const toolCall: OpenAIToolCall = item.type === "function_call"
        ? { id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments } }
        : { id: item.call_id, type: "custom", custom: { name: item.name, input: item.input } };
      if (last?.role === "assistant" && last.tool_calls) {
        last.tool_calls.push(toolCall);
      } else {
        messages.push({ role: "assistant", content: null, tool_calls: [toolCall] });
      }
    } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: item.output,
      });
    }
  }

  return messages;
}

function toolsToOpenAI(tools: unknown[]): {
  tools: Array<OpenAIFunctionTool | OpenAICustomTool>;
  webSearchOptions?: OpenAIChatRequest["web_search_options"];
} {
  const mapped: Array<OpenAIFunctionTool | OpenAICustomTool> = [];
  let webSearchOptions: OpenAIChatRequest["web_search_options"];
  for (const tool of tools) {
    if (!isRecord(tool)) {
      throw new CodexApiError(400, "Invalid Responses tool definition");
    }
    if (tool.type === "web_search") {
      webSearchOptions = {};
      if (tool.search_context_size === "low" || tool.search_context_size === "medium" || tool.search_context_size === "high") {
        webSearchOptions.search_context_size = tool.search_context_size;
      }
      if (isRecord(tool.user_location)) webSearchOptions.user_location = tool.user_location;
      continue;
    }
    if (typeof tool.name !== "string") {
      throw new CodexApiError(400, `Unsupported Chat Completions tool type: ${String(tool.type)}`);
    }
    if (tool.type === "function") {
      const fn: OpenAIFunctionTool["function"] = { name: tool.name };
      if (typeof tool.description === "string") fn.description = tool.description;
      if (isRecord(tool.parameters)) fn.parameters = tool.parameters;
      if (typeof tool.strict === "boolean") fn.strict = tool.strict;
      mapped.push({ type: "function", function: fn });
    } else if (tool.type === "custom") {
      const custom: OpenAICustomTool = { type: "custom", name: tool.name };
      if (typeof tool.description === "string") custom.description = tool.description;
      if (isRecord(tool.format)) custom.format = tool.format;
      mapped.push(custom);
    } else {
      throw new CodexApiError(400, `Unsupported Chat Completions tool type: ${String(tool.type)}`);
    }
  }
  return { tools: mapped, webSearchOptions };
}

function toolChoiceToOpenAI(choice: CodexResponsesRequest["tool_choice"]): OpenAIChatRequest["tool_choice"] {
  if (typeof choice === "string") return choice;
  if (choice?.type === "function" && choice.name) {
    return { type: "function", function: { name: choice.name } };
  }
  if (choice?.type === "custom" && choice.name) {
    return { type: "custom", name: choice.name };
  }
  return undefined;
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
    const mapped = toolsToOpenAI(req.tools);
    if (mapped.tools.length > 0) {
      body.tools = mapped.tools;
      const choice = toolChoiceToOpenAI(req.tool_choice);
      if (choice !== undefined) body.tool_choice = choice;
      if (req.parallel_tool_calls !== undefined) body.parallel_tool_calls = req.parallel_tool_calls;
    }
    if (mapped.webSearchOptions && req.tool_choice !== "none") {
      body.web_search_options = mapped.webSearchOptions;
    }
  }

  // Response format (JSON mode / structured outputs)
  if (req.text?.format) {
    const format = req.text.format;
    body.response_format = format.type === "json_schema"
      ? { type: "json_schema", json_schema: { name: format.name, schema: format.schema, strict: format.strict } }
      : { type: format.type };
  }

  return body;
}
