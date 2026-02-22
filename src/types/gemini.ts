/**
 * Google Gemini API types for generateContent / streamGenerateContent compatibility
 */
import { z } from "zod";

// --- Request ---

const GeminiPartSchema = z.object({
  text: z.string().optional(),
  thought: z.boolean().optional(),
  // Function calling fields (accepted for compatibility, not forwarded to Codex)
  functionCall: z.object({
    name: z.string(),
    args: z.record(z.unknown()).optional(),
  }).optional(),
  functionResponse: z.object({
    name: z.string(),
    response: z.record(z.unknown()).optional(),
  }).optional(),
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
  // Tool-related fields (accepted for compatibility, not forwarded to Codex)
  tools: z.array(z.object({
    functionDeclarations: z.array(z.object({
      name: z.string(),
      description: z.string().optional(),
      parameters: z.record(z.unknown()).optional(),
    })).optional(),
  }).passthrough()).optional(),
  toolConfig: z.object({
    functionCallingConfig: z.object({
      mode: z.enum(["AUTO", "NONE", "ANY"]).optional(),
      allowedFunctionNames: z.array(z.string()).optional(),
    }).optional(),
  }).optional(),
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

// --- Status map (shared by error-handler and gemini route) ---

export const GEMINI_STATUS_MAP: Record<number, string> = {
  400: "INVALID_ARGUMENT",
  401: "UNAUTHENTICATED",
  403: "PERMISSION_DENIED",
  404: "NOT_FOUND",
  429: "RESOURCE_EXHAUSTED",
  500: "INTERNAL",
  502: "INTERNAL",
  503: "UNAVAILABLE",
};

// --- Error ---

export interface GeminiErrorResponse {
  error: {
    code: number;
    message: string;
    status: string;
  };
}
