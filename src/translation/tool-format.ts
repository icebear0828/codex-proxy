/**
 * Shared tool format conversion utilities.
 *
 * Converts tool definitions and tool_choice from each protocol
 * (OpenAI, Anthropic, Gemini) into the Codex Responses API format.
 */

import type { ChatCompletionRequest } from "../types/openai.js";
import type { AnthropicMessagesRequest } from "../types/anthropic.js";
import type { GeminiGenerateContentRequest } from "../types/gemini.js";

// ── Helpers ─────────────────────────────────────────────────────

/** OpenAI requires `properties` when schema `type` is `"object"`. */
function normalizeSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (schema.type === "object" && !("properties" in schema)) {
    return { ...schema, properties: {} };
  }
  return schema;
}

// ── Codex Responses API tool format ─────────────────────────────

export interface CodexToolDefinition {
  type: "function";
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

export interface CodexHostedWebSearchTool {
  type: "web_search";
  search_context_size?: "low" | "medium" | "high";
  user_location?: Record<string, unknown>;
}

export type CodexTool = CodexToolDefinition | CodexHostedWebSearchTool;

export interface AnthropicToolConversionOptions {
  mapClaudeCodeWebSearch?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHostedWebSearchType(type: unknown): boolean {
  return type === "web_search" || type === "web_search_preview";
}

function normalizeHostedWebSearchTool(tool: Record<string, unknown>): CodexHostedWebSearchTool | null {
  if (!isHostedWebSearchType(tool.type)) return null;

  const def: CodexHostedWebSearchTool = { type: "web_search" };
  if (
    tool.search_context_size === "low" ||
    tool.search_context_size === "medium" ||
    tool.search_context_size === "high"
  ) {
    def.search_context_size = tool.search_context_size;
  }
  if (isRecord(tool.user_location)) {
    def.user_location = tool.user_location;
  }
  return def;
}

function hasGeminiHostedSearch(tool: Record<string, unknown>): boolean {
  return isRecord(tool.googleSearch) || isRecord(tool.googleSearchRetrieval);
}

function looksLikeClaudeCodeWebSearchTool(tool: Record<string, unknown>): boolean {
  if (tool.name !== "WebSearch") return false;

  const description = typeof tool.description === "string" ? tool.description.toLowerCase() : "";
  if (!description.includes("search") || !description.includes("web")) return false;

  if (!isRecord(tool.input_schema)) return false;
  const properties = isRecord(tool.input_schema.properties) ? tool.input_schema.properties : null;
  return isRecord(properties?.query);
}

function isAnthropicHostedSearchTool(
  tool: Record<string, unknown>,
  options?: AnthropicToolConversionOptions,
): boolean {
  if (tool.type === "web_search_20250305" || tool.type === "web_search") return true;
  return options?.mapClaudeCodeWebSearch === true && looksLikeClaudeCodeWebSearchTool(tool);
}

function hasAnthropicHostedSearchToolChoice(
  choiceName: string,
  tools: AnthropicMessagesRequest["tools"],
  options?: AnthropicToolConversionOptions,
): boolean {
  if (choiceName === "WebSearch" && !tools) return options?.mapClaudeCodeWebSearch === true;
  if (!tools) return false;
  return tools.some((tool) => {
    if (!isRecord(tool)) return false;
    if (
      choiceName === "WebSearch" &&
      options?.mapClaudeCodeWebSearch === true &&
      looksLikeClaudeCodeWebSearchTool(tool)
    ) {
      return true;
    }
    if (tool.type !== "web_search_20250305" && tool.type !== "web_search") {
      return false;
    }
    return typeof tool.name !== "string" || tool.name === choiceName;
  });
}

// ── OpenAI → Codex ──────────────────────────────────────────────

export function openAIToolsToCodex(
  tools: NonNullable<ChatCompletionRequest["tools"]>,
): CodexTool[] {
  const defs: CodexTool[] = [];
  for (const t of tools) {
    const hosted = normalizeHostedWebSearchTool(t);
    if (hosted) {
      defs.push(hosted);
      continue;
    }

    if (t.type !== "function") continue;
    const def: CodexToolDefinition = {
      type: "function",
      name: t.function.name,
    };
    if (t.function.description) def.description = t.function.description;
    if (t.function.parameters) def.parameters = normalizeSchema(t.function.parameters);
    defs.push(def);
  }
  return defs;
}

export function openAIToolChoiceToCodex(
  choice: ChatCompletionRequest["tool_choice"],
): string | { type: "function"; name: string } | { type: "web_search" } | undefined {
  if (!choice) return undefined;
  if (typeof choice === "string") {
    // "none" | "auto" | "required" → pass through
    return choice;
  }
  if (isHostedWebSearchType(choice.type)) {
    return { type: "web_search" };
  }
  // { type: "function", function: { name } } → { type: "function", name }
  const fn = isRecord(choice.function) ? choice.function : null;
  const name = typeof fn?.name === "string" ? fn.name : "";
  return { type: "function", name };
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
    if (f.parameters) def.parameters = normalizeSchema(f.parameters);
    return def;
  });
}

// ── Anthropic → Codex ───────────────────────────────────────────

export function anthropicToolsToCodex(
  tools: NonNullable<AnthropicMessagesRequest["tools"]>,
  options?: AnthropicToolConversionOptions,
): CodexTool[] {
  const defs: CodexTool[] = [];
  for (const t of tools) {
    if (isRecord(t) && isAnthropicHostedSearchTool(t, options)) {
      defs.push({ type: "web_search" });
      continue;
    }

    if (!("name" in t) || typeof t.name !== "string") continue;
    const def: CodexToolDefinition = {
      type: "function",
      name: t.name,
    };
    if (isRecord(t) && typeof t.description === "string") def.description = t.description;
    if (isRecord(t) && isRecord(t.input_schema)) def.parameters = normalizeSchema(t.input_schema);
    defs.push(def);
  }
  return defs;
}

export function anthropicToolChoiceToCodex(
  choice: AnthropicMessagesRequest["tool_choice"],
  tools?: AnthropicMessagesRequest["tools"],
  options?: AnthropicToolConversionOptions,
): string | { type: "function"; name: string } | { type: "web_search" } | undefined {
  if (!choice) return undefined;
  switch (choice.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "tool":
      if (hasAnthropicHostedSearchToolChoice(choice.name, tools, options)) {
        return { type: "web_search" };
      }
      return { type: "function", name: choice.name };
    default:
      return undefined;
  }
}

// ── Gemini → Codex ──────────────────────────────────────────────

export function geminiToolsToCodex(
  tools: NonNullable<GeminiGenerateContentRequest["tools"]>,
): CodexTool[] {
  const defs: CodexTool[] = [];
  for (const toolGroup of tools) {
    if (hasGeminiHostedSearch(toolGroup)) {
      defs.push({ type: "web_search" });
    }

    if (toolGroup.functionDeclarations) {
      for (const fd of toolGroup.functionDeclarations) {
        const def: CodexToolDefinition = {
          type: "function",
          name: fd.name,
        };
        if (fd.description) def.description = fd.description;
        if (fd.parameters) def.parameters = normalizeSchema(fd.parameters);
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
