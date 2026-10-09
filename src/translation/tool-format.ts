/**
 * Shared tool format conversion utilities.
 *
 * Converts tool definitions and tool_choice from each protocol
 * (OpenAI, Anthropic, Gemini) into the Codex Responses API format.
 */

import type { ChatCompletionRequest } from "../types/openai.js";
import type { AnthropicMessagesRequest } from "../types/anthropic.js";
import type { GeminiGenerateContentRequest } from "../types/gemini.js";
import { isRecord, sanitizeSchemaPatterns } from "./shared-utils.js";

// ── Helpers ─────────────────────────────────────────────────────

/**
 * OpenAI requires `properties` when schema `type` is `"object"`.
 *
 * 只在缺 `properties` 时补一个空对象，不做任何其他变换。
 */
function ensureObjectProperties(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (schema.type === "object" && !("properties" in schema)) {
    return { ...schema, properties: {} };
  }
  return schema;
}

/**
 * 工具参数 schema 的归一化，三条协议（Anthropic / OpenAI / Gemini）的工具
 * 参数都只经过这里：
 *
 * 1. 清掉上游正则引擎编译不了的正则约束（见 `sanitizeSchemaPatterns` 的说明
 *    ——Claude Code 内置 Artifact 工具的 pattern 会让上游在提交那一刻拒收
 *    整个请求）；
 * 2. 补上 OpenAI 要求的 `properties`。
 *
 * 刻意**不**注入 `additionalProperties`、也不做 tuple 转换——那是
 * `prepareSchema()` 的职责，目前只用在结构化输出 schema（`text.format`）上。
 * 把那些行为顺手带进工具参数路径会改变既有输出。
 */
function normalizeSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  return ensureObjectProperties(sanitizeSchemaPatterns(schema));
}

// ── Codex Responses API tool format ─────────────────────────────

export interface CodexToolDefinition {
  type: "function";
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

export interface CodexCustomToolDefinition {
  type: "custom";
  name: string;
  description?: string;
  format?: Record<string, unknown>;
}

export interface CodexHostedWebSearchTool {
  type: "web_search";
  search_context_size?: "low" | "medium" | "high";
  user_location?: Record<string, unknown>;
}

export interface CodexImageGenerationTool {
  type: "image_generation";
  [key: string]: unknown;
}

export type CodexTool =
  | CodexToolDefinition
  | CodexCustomToolDefinition
  | CodexHostedWebSearchTool
  | CodexImageGenerationTool;

export interface AnthropicToolConversionOptions {
  mapClaudeCodeWebSearch?: boolean;
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

    if (t.type === "image_generation") {
      defs.push(t);
      continue;
    }

    if (t.type === "custom") {
      const def: CodexCustomToolDefinition = {
        type: "custom",
        name: t.name,
      };
      if (t.description) def.description = t.description;
      if (t.format) def.format = t.format;
      defs.push(def);
      continue;
    }

    if (t.type !== "function") continue;
    const def: CodexToolDefinition = {
      type: "function",
      name: t.function.name,
      strict: t.function.strict ?? false,
    };
    if (t.function.description) def.description = t.function.description;
    if (t.function.parameters) def.parameters = normalizeSchema(t.function.parameters);
    defs.push(def);
  }
  return defs;
}

export function openAIToolChoiceToCodex(
  choice: ChatCompletionRequest["tool_choice"],
): string | { type: "function"; name: string } | { type: "custom"; name: string } | { type: "web_search" } | undefined {
  if (!choice) return undefined;
  if (typeof choice === "string") {
    // "none" | "auto" | "required" → pass through
    return choice;
  }
  if (isHostedWebSearchType(choice.type)) {
    return { type: "web_search" };
  }
  // { type: "function", function: { name } } → { type: "function", name }
  if (choice.type === "custom") {
    return { type: "custom", name: choice.name };
  }
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
      strict: f.strict ?? false,
    };
    if (f.description) def.description = f.description;
    if (f.parameters) def.parameters = normalizeSchema(f.parameters);
    return def;
  });
}

// ── Anthropic → Codex ───────────────────────────────────────────

// Upstream models tend to fill optional string fields with `""` rather than
// omit them. Claude Code's Read tool then routes `pages: ""` into its PDF
// branch and errors. Nudge the model via the property description.
const READ_PAGES_HINT =
  " Omit this field entirely for non-PDF files; do not pass an empty string.";

function augmentReadToolSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (!isRecord(schema.properties)) return schema;
  const pages = schema.properties.pages;
  if (!isRecord(pages)) return schema;
  const desc = typeof pages.description === "string" ? pages.description : "";
  if (desc.endsWith(READ_PAGES_HINT)) return schema;
  return {
    ...schema,
    properties: {
      ...schema.properties,
      pages: { ...pages, description: desc + READ_PAGES_HINT },
    },
  };
}

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
    if (isRecord(t) && isRecord(t.input_schema)) {
      const schema = t.name === "Read" ? augmentReadToolSchema(t.input_schema) : t.input_schema;
      def.parameters = normalizeSchema(schema);
    }
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
    case "none":
      return "none";
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
