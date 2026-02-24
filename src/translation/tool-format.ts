/**
 * Shared tool format conversion utilities.
 *
 * Converts tool definitions and tool_choice from each protocol
 * (OpenAI, Anthropic, Gemini) into the Codex Responses API format.
 */

import type { ChatCompletionRequest } from "../types/openai.js";
import type { AnthropicMessagesRequest } from "../types/anthropic.js";
import type { GeminiGenerateContentRequest } from "../types/gemini.js";

// ── Codex Responses API tool format ─────────────────────────────

export interface CodexToolDefinition {
  type: "function";
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

// ── OpenAI → Codex ──────────────────────────────────────────────

export function openAIToolsToCodex(
  tools: NonNullable<ChatCompletionRequest["tools"]>,
): CodexToolDefinition[] {
  return tools.map((t) => {
    const def: CodexToolDefinition = {
      type: "function",
      name: t.function.name,
    };
    if (t.function.description) def.description = t.function.description;
    if (t.function.parameters) def.parameters = t.function.parameters;
    return def;
  });
}

export function openAIToolChoiceToCodex(
  choice: ChatCompletionRequest["tool_choice"],
): string | { type: "function"; name: string } | undefined {
  if (!choice) return undefined;
  if (typeof choice === "string") {
    // "none" | "auto" | "required" → pass through
    return choice;
  }
  // { type: "function", function: { name } } → { type: "function", name }
  return { type: "function", name: choice.function.name };
}

/**
 * Convert legacy OpenAI `functions` array to Codex tool definitions.
 */
export function openAIFunctionsToCodex(
  functions: NonNullable<ChatCompletionRequest["functions"]>,
): CodexToolDefinition[] {
  return functions.map((f) => {
    const def: CodexToolDefinition = {
      type: "function",
      name: f.name,
    };
    if (f.description) def.description = f.description;
    if (f.parameters) def.parameters = f.parameters;
    return def;
  });
}

// ── Anthropic → Codex ───────────────────────────────────────────

export function anthropicToolsToCodex(
  tools: NonNullable<AnthropicMessagesRequest["tools"]>,
): CodexToolDefinition[] {
  return tools.map((t) => {
    const def: CodexToolDefinition = {
      type: "function",
      name: t.name,
    };
    if (t.description) def.description = t.description;
    if (t.input_schema) def.parameters = t.input_schema;
    return def;
  });
}

export function anthropicToolChoiceToCodex(
  choice: AnthropicMessagesRequest["tool_choice"],
): string | { type: "function"; name: string } | undefined {
  if (!choice) return undefined;
  switch (choice.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "tool":
      return { type: "function", name: choice.name };
    default:
      return undefined;
  }
}

// ── Gemini → Codex ──────────────────────────────────────────────

export function geminiToolsToCodex(
  tools: NonNullable<GeminiGenerateContentRequest["tools"]>,
): CodexToolDefinition[] {
  const defs: CodexToolDefinition[] = [];
  for (const toolGroup of tools) {
    if (toolGroup.functionDeclarations) {
      for (const fd of toolGroup.functionDeclarations) {
        const def: CodexToolDefinition = {
          type: "function",
          name: fd.name,
        };
        if (fd.description) def.description = fd.description;
        if (fd.parameters) def.parameters = fd.parameters;
        defs.push(def);
      }
    }
  }
  return defs;
}

export function geminiToolConfigToCodex(
  config: GeminiGenerateContentRequest["toolConfig"],
): string | undefined {
  if (!config?.functionCallingConfig?.mode) return undefined;
  switch (config.functionCallingConfig.mode) {
    case "AUTO":
      return "auto";
    case "NONE":
      return "none";
    case "ANY":
      return "required";
    default:
      return undefined;
  }
}
