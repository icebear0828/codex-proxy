/**
 * OpenAI API types for /v1/chat/completions compatibility
 */
import { z } from "zod";

// --- Request ---

const ContentPartSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
}).passthrough();

export const ChatMessageSchema = z.object({
  role: z.enum(["system", "developer", "user", "assistant"]),
  content: z.union([z.string(), z.array(ContentPartSchema)]),
  name: z.string().optional(),
});

export const ChatCompletionRequestSchema = z.object({
  model: z.string(),
  messages: z.array(ChatMessageSchema).min(1),
  stream: z.boolean().optional().default(false),
  n: z.number().optional().default(1),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  max_tokens: z.number().optional(),
  presence_penalty: z.number().optional(),
  frequency_penalty: z.number().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  user: z.string().optional(),
  // Codex-specific extensions
  reasoning_effort: z.enum(["low", "medium", "high", "xhigh"]).optional(),
});

export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;

// --- Response (non-streaming) ---

export interface ChatCompletionChoice {
  index: number;
  message: {
    role: "assistant";
    content: string;
  };
  finish_reason: "stop" | "length" | null;
}

export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
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

export interface ChatCompletionChunkDelta {
  role?: "assistant";
  content?: string;
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: ChatCompletionChunkDelta;
  finish_reason: "stop" | "length" | null;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
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
