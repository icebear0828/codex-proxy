/**
 * Google Gemini API types for generateContent / streamGenerateContent compatibility
 */
import { z } from "zod";

// --- Request ---

const GeminiPartSchema = z.object({
  text: z.string().optional(),
  thought: z.boolean().optional(),
});

const GeminiContentSchema = z.object({
  role: z.enum(["user", "model"]).optional(),
  parts: z.array(GeminiPartSchema).min(1),
});

const GeminiThinkingConfigSchema = z.object({
  thinkingBudget: z.number().optional(),
});

const GeminiGenerationConfigSchema = z.object({
  temperature: z.number().optional(),
  topP: z.number().optional(),
  topK: z.number().optional(),
  maxOutputTokens: z.number().optional(),
  stopSequences: z.array(z.string()).optional(),
  thinkingConfig: GeminiThinkingConfigSchema.optional(),
});

export const GeminiGenerateContentRequestSchema = z.object({
  contents: z.array(GeminiContentSchema).min(1),
  systemInstruction: GeminiContentSchema.optional(),
  generationConfig: GeminiGenerationConfigSchema.optional(),
});

export type GeminiGenerateContentRequest = z.infer<
  typeof GeminiGenerateContentRequestSchema
>;
export type GeminiContent = z.infer<typeof GeminiContentSchema>;

// --- Response ---

export interface GeminiCandidate {
  content: {
    parts: Array<{ text: string; thought?: boolean }>;
    role: "model";
  };
  finishReason?: "STOP" | "MAX_TOKENS" | "SAFETY" | "OTHER";
  index: number;
}

export interface GeminiUsageMetadata {
  promptTokenCount: number;
  candidatesTokenCount: number;
  totalTokenCount: number;
}

export interface GeminiGenerateContentResponse {
  candidates: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
  modelVersion?: string;
}

// --- Error ---

export interface GeminiErrorResponse {
  error: {
    code: number;
    message: string;
    status: string;
  };
}
