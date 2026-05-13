/**
 * OpenAI API types for /v1/chat/completions compatibility
 */
import { z } from "zod";

// --- Request ---

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isReasoningEffort(value: unknown): value is "low" | "medium" | "high" | "xhigh" {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

function isChatRole(value: unknown): value is "system" | "developer" | "user" | "assistant" | "tool" | "function" {
  return value === "system" ||
    value === "developer" ||
    value === "user" ||
    value === "assistant" ||
    value === "tool" ||
    value === "function";
}

function normalizeResponsesContentPart(part: unknown): unknown {
  if (!isRecord(part)) return part;

  if (part.type === "input_text" || part.type === "output_text") {
    return { type: "text", text: optionalString(part.text) ?? "" };
  }

  if (part.type === "input_image") {
    const imageUrl = part.image_url ?? part.url;
    return { type: "image_url", image_url: imageUrl };
  }

  return part;
}

function normalizeResponsesContent(content: unknown): unknown {
  if (typeof content === "string" || content === null || content === undefined) {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map(normalizeResponsesContentPart);
  }
  if (isRecord(content)) {
    return [normalizeResponsesContentPart(content)];
  }
  return safeStringify(content);
}

function responsesContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (!Array.isArray(content)) return safeStringify(content);

  return content
    .map((part) => {
      if (!isRecord(part)) return safeStringify(part);
      if (typeof part.text === "string") return part.text;
      if (typeof part.output === "string") return part.output;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeResponsesInputItem(item: unknown): unknown[] {
  if (typeof item === "string") {
    return [{ role: "user", content: item }];
  }
  if (!isRecord(item)) {
    return [];
  }

  if (item.type === "function_call") {
    const name = optionalString(item.name);
    if (!name) return [];
    const callId = optionalString(item.call_id) ?? optionalString(item.id) ?? `fc_${name}`;
    return [{
      role: "assistant",
      content: null,
      tool_calls: [{
        id: callId,
        type: "function",
        function: {
          name,
          arguments: safeStringify(item.arguments),
        },
      }],
    }];
  }

  if (item.type === "function_call_output") {
    const callId = optionalString(item.call_id) ?? optionalString(item.id) ?? "unknown";
    return [{
      role: "tool",
      content: responsesContentToText(item.output ?? item.content),
      tool_call_id: callId,
    }];
  }

  if (item.type === "message" || isChatRole(item.role)) {
    const role = isChatRole(item.role) ? item.role : "user";
    const message: Record<string, unknown> = {
      role,
      content: normalizeResponsesContent(item.content),
    };
    if (typeof item.name === "string") message.name = item.name;
    if (typeof item.tool_call_id === "string") message.tool_call_id = item.tool_call_id;
    if (Array.isArray(item.tool_calls)) message.tool_calls = item.tool_calls;
    if (isRecord(item.function_call)) message.function_call = item.function_call;
    return [message];
  }

  if (item.type === "input_text" || item.type === "output_text") {
    return [{ role: "user", content: optionalString(item.text) ?? "" }];
  }

  return [];
}

function normalizeResponsesInput(input: unknown): unknown[] {
  if (typeof input === "string") {
    return [{ role: "user", content: input }];
  }
  if (Array.isArray(input)) {
    return input.flatMap(normalizeResponsesInputItem);
  }
  if (isRecord(input)) {
    return normalizeResponsesInputItem(input);
  }
  return [];
}

function normalizeFlatTool(tool: unknown): unknown {
  if (!isRecord(tool)) return tool;

  const type = tool.type;
  const existingFunction = optionalRecord(tool.function);
  if (type !== "function" && type !== "custom") return tool;
  if (existingFunction) return tool;

  const name = optionalString(tool.name);
  if (!name) return tool;

  const fn: Record<string, unknown> = { name };
  const description = optionalString(tool.description);
  const parameters =
    optionalRecord(tool.parameters) ??
    optionalRecord(tool.input_schema) ??
    optionalRecord(tool.schema);

  if (description) fn.description = description;
  if (parameters) fn.parameters = parameters;
  if (typeof tool.strict === "boolean") fn.strict = tool.strict;

  return { type: "function", function: fn };
}

function normalizeToolChoice(choice: unknown): unknown {
  if (!isRecord(choice)) return choice;
  if ((choice.type === "function" || choice.type === "custom") && !isRecord(choice.function)) {
    const name = optionalString(choice.name);
    if (name) return { type: "function", function: { name } };
  }
  return choice;
}

function normalizeChatCompletionRequestInput(value: unknown): unknown {
  if (!isRecord(value)) return value;

  const normalized: Record<string, unknown> = { ...value };

  if (!Array.isArray(normalized.messages) && "input" in value) {
    const messages = normalizeResponsesInput(value.input);
    const instructions = optionalString(value.instructions);
    if (instructions) {
      messages.unshift({ role: "system", content: instructions });
    }
    if (messages.length > 0) {
      normalized.messages = messages;
    }
  }

  const reasoning = optionalRecord(value.reasoning);
  if (normalized.reasoning_effort === undefined && reasoning && isReasoningEffort(reasoning.effort)) {
    normalized.reasoning_effort = reasoning.effort;
  }

  if (Array.isArray(value.tools)) {
    normalized.tools = value.tools.map(normalizeFlatTool);
  }

  if ("tool_choice" in value) {
    normalized.tool_choice = normalizeToolChoice(value.tool_choice);
  }

  return normalized;
}

const ContentPartSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
}).passthrough();

export const ChatMessageSchema = z.object({
  role: z.enum(["system", "developer", "user", "assistant", "tool", "function"]),
  content: z.union([z.string(), z.array(ContentPartSchema)]).nullable().optional(),
  name: z.string().optional(),
  // New format: tool_calls (array, on assistant messages)
  tool_calls: z.array(z.object({
    id: z.string(),
    type: z.literal("function"),
    function: z.object({
      name: z.string(),
      arguments: z.string(),
    }),
  })).optional(),
  tool_call_id: z.string().optional(),
  // Legacy format: function_call (single object, on assistant messages)
  function_call: z.object({
    name: z.string(),
    arguments: z.string(),
  }).optional(),
});

const ChatCompletionRequestObjectSchema = z.object({
  model: z.string(),
  messages: z.array(ChatMessageSchema).min(1),
  stream: z.boolean().optional().default(false),
  n: z.number().optional().default(1),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  max_tokens: z.number().optional(),
  max_completion_tokens: z.number().optional(),
  max_output_tokens: z.number().optional(),
  presence_penalty: z.number().optional(),
  frequency_penalty: z.number().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  user: z.string().optional(),
  // Codex-specific extensions
  reasoning_effort: z.enum(["low", "medium", "high", "xhigh"]).optional(),
  service_tier: z.enum(["fast", "flex"]).nullable().optional(),
  // New tool format. In addition to function tools, accept hosted web search
  // tools so OpenAI-compatible clients can ask Codex to search natively.
  tools: z.array(z.union([
    z.object({
      type: z.literal("function"),
      function: z.object({
        name: z.string(),
        description: z.string().optional(),
        parameters: z.record(z.unknown()).optional(),
        strict: z.boolean().optional(),
      }),
    }),
    z.object({
      type: z.enum(["web_search", "web_search_preview"]),
      search_context_size: z.enum(["low", "medium", "high"]).optional(),
      user_location: z.record(z.unknown()).optional(),
    }).passthrough(),
    z.object({
      type: z.literal("image_generation"),
    }).passthrough(),
  ])).optional(),
  tool_choice: z.union([
    z.enum(["none", "auto", "required"]),
    z.object({ type: z.literal("function"), function: z.object({ name: z.string() }) }),
    z.object({ type: z.enum(["web_search", "web_search_preview"]) }).passthrough(),
  ]).optional(),
  parallel_tool_calls: z.boolean().optional(),
  // Structured output format (JSON mode / JSON Schema)
  response_format: z.object({
    type: z.enum(["text", "json_object", "json_schema"]),
    json_schema: z.object({
      name: z.string(),
      schema: z.record(z.unknown()),
      strict: z.boolean().optional(),
    }).optional(),
  }).optional(),
  // Legacy function format (accepted for compatibility, not forwarded to Codex)
  functions: z.array(z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.unknown()).optional(),
    strict: z.boolean().optional(),
  })).optional(),
  function_call: z.union([
    z.enum(["none", "auto"]),
    z.object({ name: z.string() }),
  ]).optional(),
});

export const ChatCompletionRequestSchema = z.preprocess(
  normalizeChatCompletionRequestInput,
  ChatCompletionRequestObjectSchema,
);

export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;

// --- Response (non-streaming) ---

export interface ChatCompletionToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatCompletionChoice {
  index: number;
  message: {
    role: "assistant";
    content: string | null;
    reasoning_content?: string | null;
    tool_calls?: ChatCompletionToolCall[];
  };
  finish_reason: "stop" | "length" | "tool_calls" | "function_call" | null;
}

export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: ChatCompletionUsage;
}

// --- Response (streaming) ---

export interface ChatCompletionChunkToolCall {
  index: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface ChatCompletionChunkDelta {
  role?: "assistant";
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: ChatCompletionChunkToolCall[];
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: ChatCompletionChunkDelta;
  finish_reason: "stop" | "length" | "tool_calls" | "function_call" | null;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
  usage?: ChatCompletionUsage | null;
}

// --- Error ---

export interface OpenAIErrorBody {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
}

// --- Models ---

export interface OpenAIModel {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

export interface OpenAIModelList {
  object: "list";
  data: OpenAIModel[];
}
