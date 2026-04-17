/**
 * Anthropic Messages API types for /v1/messages compatibility
 */
import { z } from "zod";

// --- Request ---

const AnthropicCacheControlSchema = z.object({
  type: z.string(),
}).passthrough();

const AnthropicTextContentSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
  cache_control: AnthropicCacheControlSchema.optional(),
});

const AnthropicImageContentSchema = z.object({
  type: z.literal("image"),
  source: z.object({
    type: z.literal("base64"),
    media_type: z.string(),
    data: z.string(),
  }),
});

const AnthropicToolUseContentSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.record(z.unknown()),
});

const AnthropicToolResultContentBlockSchema = z.discriminatedUnion("type", [
  AnthropicTextContentSchema,
  AnthropicImageContentSchema,
]);

const AnthropicToolResultContentSchema = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(AnthropicToolResultContentBlockSchema)]).optional(),
  is_error: z.boolean().optional(),
});

// Extended thinking content blocks (sent back in conversation history)
const AnthropicThinkingContentSchema = z.object({
  type: z.literal("thinking"),
  thinking: z.string(),
  signature: z.string().optional(),
});

const AnthropicRedactedThinkingContentSchema = z.object({
  type: z.literal("redacted_thinking"),
  data: z.string(),
});

const AnthropicContentBlockSchema = z.union([
  z.discriminatedUnion("type", [
    AnthropicTextContentSchema,
    AnthropicImageContentSchema,
    AnthropicToolUseContentSchema,
    AnthropicToolResultContentSchema,
    AnthropicThinkingContentSchema,
    AnthropicRedactedThinkingContentSchema,
  ]),
  // Catch-all: forward-compatibility for new content block types (e.g. "document")
  // introduced by Claude Code updates. Unknown types are passed through and ignored
  // by translation functions.
  z.object({ type: z.string() }).passthrough(),
]);

const AnthropicContentSchema = z.union([
  z.string(),
  z.array(AnthropicContentBlockSchema),
]);

const AnthropicMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: AnthropicContentSchema,
});

const AnthropicThinkingEnabledSchema = z.object({
  type: z.literal("enabled"),
  budget_tokens: z.number().int().positive(),
});

const AnthropicThinkingDisabledSchema = z.object({
  type: z.literal("disabled"),
});

const AnthropicThinkingAdaptiveSchema = z.object({
  type: z.literal("adaptive"),
  budget_tokens: z.number().int().positive().optional(),
});

export const AnthropicMessagesRequestSchema = z.object({
  model: z.string(),
  max_tokens: z.number().int().positive(),
  messages: z.array(AnthropicMessageSchema).min(1),
  system: z
    .union([z.string(), z.array(AnthropicTextContentSchema)])
    .optional(),
  stream: z.boolean().optional().default(false),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  top_k: z.number().optional(),
  stop_sequences: z.array(z.string()).optional(),
  metadata: z
    .object({
      user_id: z.string().optional(),
    })
    .optional(),
  thinking: z
    .union([
      AnthropicThinkingEnabledSchema,
      AnthropicThinkingDisabledSchema,
      AnthropicThinkingAdaptiveSchema,
    ])
    .optional(),
  // Tool-related fields. Custom tools are converted to Codex function tools;
  // Anthropic hosted web search is converted to Codex hosted web_search.
  tools: z.array(z.union([
    z.object({
      name: z.string(),
      description: z.string().optional(),
      input_schema: z.record(z.unknown()).optional(),
    }).passthrough(),
    z.object({
      type: z.enum(["web_search_20250305", "web_search"]),
      name: z.string().optional(),
      max_uses: z.number().int().positive().optional(),
      allowed_domains: z.array(z.string()).optional(),
      blocked_domains: z.array(z.string()).optional(),
      user_location: z.record(z.unknown()).optional(),
    }).passthrough(),
  ])).optional(),
  tool_choice: z.union([
    z.object({ type: z.literal("auto") }),
    z.object({ type: z.literal("any") }),
    z.object({ type: z.literal("tool"), name: z.string() }),
  ]).optional(),
});

export type AnthropicMessagesRequest = z.infer<
  typeof AnthropicMessagesRequestSchema
>;

// --- Response ---

export interface AnthropicContentBlock {
  type: "text" | "thinking" | "tool_use";
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface AnthropicMessagesResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

// --- Error ---

export type AnthropicErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "not_found_error"
  | "rate_limit_error"
  | "api_error"
  | "overloaded_error";

export interface AnthropicErrorBody {
  type: "error";
  error: {
    type: AnthropicErrorType;
    message: string;
  };
}
