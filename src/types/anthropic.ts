/**
 * Anthropic Messages API types for /v1/messages compatibility
 */
import { z } from "zod";

// --- Request ---

const AnthropicTextContentSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
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

const AnthropicToolResultContentSchema = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(AnthropicTextContentSchema)]).optional(),
  is_error: z.boolean().optional(),
});

const AnthropicContentBlockSchema = z.discriminatedUnion("type", [
  AnthropicTextContentSchema,
  AnthropicImageContentSchema,
  AnthropicToolUseContentSchema,
  AnthropicToolResultContentSchema,
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
    .union([AnthropicThinkingEnabledSchema, AnthropicThinkingDisabledSchema])
    .optional(),
  // Tool-related fields (accepted for compatibility, not forwarded to Codex)
  tools: z.array(z.object({
    name: z.string(),
    description: z.string().optional(),
    input_schema: z.record(z.unknown()).optional(),
  }).passthrough()).optional(),
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
