/**
 * Translate CodexResponsesRequest → Google Gemini generateContent request body.
 *
 * Key differences:
 *   - System prompt uses `system_instruction` (separate field)
 *   - Messages use `contents[]` with `role: "user"/"model"` (not "assistant")
 *   - Tool calls use `functionCall` / `functionResponse` part types
 *   - Images use `inlineData` or `fileData`
 */

import type { CodexInputItem, CodexContentPart, CodexResponsesRequest } from "../proxy/codex-types.js";
import { CodexApiError } from "../proxy/codex-types.js";
import type { CodexToolDefinition } from "./tool-format.js";
import { REASONING_EFFORT_BUDGET } from "./shared-utils.js";

const GEMINI_SCHEMA_FIELDS = new Set([
  "type", "format", "title", "description", "nullable", "default", "items", "minItems",
  "maxItems", "enum", "properties", "propertyOrdering", "required", "minProperties",
  "maxProperties", "minimum", "maximum", "minLength", "maxLength", "pattern", "example", "anyOf",
]);

interface GeminiTextPart { text: string }
interface GeminiInlineDataPart { inlineData: { mimeType: string; data: string } }
interface GeminiFunctionCallPart { functionCall: { name: string; args: Record<string, unknown>; id?: string }; thoughtSignature?: string }
interface GeminiFunctionResponsePart { functionResponse: { name: string; response: unknown; id?: string } }

type GeminiPart =
  | GeminiTextPart
  | GeminiInlineDataPart
  | GeminiFunctionCallPart
  | GeminiFunctionResponsePart;

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiTool {
  functionDeclarations: Array<{
    name: string;
    description?: string;
    parameters?: unknown;
  }>;
}

function instructionText(content: string | CodexContentPart[]): string {
  return typeof content === "string"
    ? content
    : content.filter((part) => part.type === "input_text").map((part) => part.text).join("\n");
}

interface GeminiToolConfig { functionCallingConfig: { mode: "AUTO" | "ANY" | "NONE"; allowedFunctionNames?: string[] } }

export interface GeminiGenerateContentRequest {
  contents: GeminiContent[];
  system_instruction?: { parts: Array<{ text: string }> };
  tools?: GeminiTool[];
  toolConfig?: GeminiToolConfig;
  generationConfig?: {
    responseMimeType?: string;
    responseSchema?: unknown;
    thinkingConfig?: { thinkingBudget: number };
  };
}

function codexPartToGemini(part: CodexContentPart): GeminiPart {
  if (part.type === "input_text") return { text: part.text };
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(part.image_url);
  if (!match) throw new CodexApiError(400, "Gemini image input requires a base64 data URI");
  return { inlineData: { mimeType: match[1], data: match[2] } };
}

function inputItemsToGeminiContents(input: CodexInputItem[]): GeminiContent[] {
  const contents: GeminiContent[] = [];
  const callNames = new Map<string, string>();

  for (const item of input) {
    if ("role" in item) {
      const role = item.role;
      if (role === "system" || role === "developer") continue;
      const geminiRole = role === "assistant" ? "model" as const : "user" as const;

      if (typeof item.content === "string") {
        contents.push({ role: geminiRole, parts: [{ text: item.content }] });
      } else {
        contents.push({ role: geminiRole, parts: item.content.map(codexPartToGemini) });
      }
    } else if (item.type === "function_call") {
      let args: unknown;
      try { args = JSON.parse(item.arguments); } catch {
        throw new CodexApiError(400, `Invalid JSON arguments for tool ${item.name}`);
      }
      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        throw new CodexApiError(400, `Tool ${item.name} arguments must be a JSON object`);
      }
      callNames.set(item.call_id, item.name);
      const fnCallPart: GeminiFunctionCallPart = {
        functionCall: {
          name: item.name,
          id: item.call_id,
          args: args as Record<string, unknown>,
        },
        thoughtSignature: item.signature || "skip_thought_signature_validator",
      };
      const last = contents.at(-1);
      if (last?.role === "model") {
        last.parts.push(fnCallPart);
      } else {
        contents.push({ role: "model", parts: [fnCallPart] });
      }
    } else if (item.type === "function_call_output") {
      const name = callNames.get(item.call_id);
      if (!name) throw new CodexApiError(400, `Tool result has no matching call: ${item.call_id}`);
      const fnRespPart: GeminiFunctionResponsePart = {
        functionResponse: {
          name,
          id: item.call_id,
          response: { output: item.output },
        },
      };
      const last = contents.at(-1);
      if (last?.role === "user") {
        last.parts.push(fnRespPart);
      } else {
        contents.push({ role: "user", parts: [fnRespPart] });
      }
    }
  }

  return contents;
}

function convertToolsToGemini(tools: unknown[]): GeminiTool[] {
  const declarations: GeminiTool["functionDeclarations"] = [];
  for (const tool of tools) {
    if (
      typeof tool === "object" && tool !== null &&
      "type" in tool && (tool as { type: unknown }).type === "function" &&
      "name" in tool && typeof (tool as { name: unknown }).name === "string"
    ) {
      const fn = tool as CodexToolDefinition;
      declarations.push({
        name: fn.name,
        description: fn.description,
        parameters: fn.parameters ? sanitizeGeminiSchema(fn.parameters) : undefined,
      });
    }
  }
  return declarations.length ? [{ functionDeclarations: declarations }] : [];
}

function sanitizeGeminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const resolveRef = (ref: string): unknown => {
    if (!ref.startsWith("#/")) throw new CodexApiError(400, `Unsupported external tool schema reference: ${ref}`);
    let target: unknown = schema;
    for (const segment of ref.slice(2).split("/")) {
      const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
      if (typeof target !== "object" || target === null || Array.isArray(target) || !(key in target)) {
        throw new CodexApiError(400, `Missing tool schema reference: ${ref}`);
      }
      target = (target as Record<string, unknown>)[key];
    }
    return target;
  };
  const visit = (value: unknown, refs: Set<string>): Record<string, unknown> => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    const node = value as Record<string, unknown>;
    let source = node;
    if (typeof node.$ref === "string") {
      const target = resolveRef(node.$ref);
      if (refs.has(node.$ref)) {
        const recursive = target as Record<string, unknown>;
        const type = typeof recursive.type === "string" ? recursive.type.toUpperCase()
          : recursive.items ? "ARRAY" : "OBJECT";
        return { type, ...(typeof recursive.description === "string" ? { description: recursive.description } : {}) };
      }
      source = { ...visit(target, new Set([...refs, node.$ref])), ...node };
    }
    if (Array.isArray(source.allOf)) {
      source = source.allOf.reduce<Record<string, unknown>>((merged, branch) => {
        const resolved = visit(branch, refs);
        return {
          ...merged, ...resolved,
          properties: { ...(merged.properties as Record<string, unknown> | undefined), ...(resolved.properties as Record<string, unknown> | undefined) },
          required: [...new Set([...(merged.required as string[] | undefined ?? []), ...(resolved.required as string[] | undefined ?? [])])],
        };
      }, { ...source });
    }
    if (Array.isArray(source.oneOf) && !Array.isArray(source.anyOf)) {
      source = { ...source, anyOf: source.oneOf };
    }
    const result: Record<string, unknown> = {};
    if ("const" in source && !Array.isArray(source.enum)) result.enum = [source.const];
    for (const [key, child] of Object.entries(source)) {
      if (!GEMINI_SCHEMA_FIELDS.has(key)) continue;
      if (key === "properties" && typeof child === "object" && child !== null && !Array.isArray(child)) {
        result.properties = Object.fromEntries(Object.entries(child).map(([name, field]) => [name, visit(field, refs)]));
      } else if (key === "items") {
        result.items = visit(child, refs);
      } else if (key === "anyOf" && Array.isArray(child)) {
        const nonNull = child.filter((entry) => !(typeof entry === "object" && entry !== null && !Array.isArray(entry) && (entry as Record<string, unknown>).type === "null"));
        if (nonNull.length !== child.length) result.nullable = true;
        if (nonNull.length === 1) Object.assign(result, visit(nonNull[0], refs));
        else if (nonNull.length > 1) result.anyOf = nonNull.map((entry) => visit(entry, refs));
      } else if (key === "type" && Array.isArray(child)) {
        const types = child.filter((type): type is string => typeof type === "string" && type !== "null");
        if (child.includes("null")) result.nullable = true;
        if (types.length === 1) result.type = types[0].toUpperCase();
        else if (types.length > 1) result.anyOf = types.map((type) => ({ type: type.toUpperCase() }));
      } else if (key === "type" && typeof child === "string") {
        result.type = child.toUpperCase();
      } else {
        result[key] = child;
      }
    }
    if (!result.type && result.properties) result.type = "OBJECT";
    return result;
  };
  return visit(schema, new Set());
}


export function translateCodexToGeminiRequest(
  req: CodexResponsesRequest,
): GeminiGenerateContentRequest {
  const contents = inputItemsToGeminiContents(req.input);

  const body: GeminiGenerateContentRequest = { contents };

  const instructionParts: Array<{ text: string }> = [];
  if (req.instructions) instructionParts.push({ text: req.instructions });
  for (const item of req.input) {
    if ("role" in item && (item.role === "system" || item.role === "developer")) {
      const text = instructionText(item.content);
      if (text) instructionParts.push({ text });
    }
  }
  if (instructionParts.length) body.system_instruction = { parts: instructionParts };

  if (req.tools?.length) {
    body.tools = convertToolsToGemini(req.tools);
  }

  if (req.tool_choice) {
    const choice = req.tool_choice;
    if (typeof choice === "string" && !["none", "required", "auto"].includes(choice)) {
      throw new CodexApiError(400, `Unsupported Gemini tool choice: ${choice}`);
    }
    if (typeof choice === "object" && (choice.type !== "function" || !choice.name)) {
      throw new CodexApiError(400, "Gemini requires a named function tool choice");
    }
    const mode = choice === "none" ? "NONE" : choice === "required" ? "ANY" : "AUTO";
    body.toolConfig = { functionCallingConfig: { mode } };
    if (typeof choice === "object" && choice.type === "function" && choice.name) {
      body.toolConfig.functionCallingConfig = { mode: "ANY", allowedFunctionNames: [choice.name] };
    }
  }

  if (req.text?.format || req.reasoning?.effort) {
    body.generationConfig = {};
    if (req.text?.format?.type === "json_object") {
      body.generationConfig.responseMimeType = "application/json";
    } else if (req.text?.format?.type === "json_schema" && req.text.format.schema) {
      body.generationConfig.responseMimeType = "application/json";
      body.generationConfig.responseSchema = sanitizeGeminiSchema(req.text.format.schema);
    }
    if (req.reasoning?.effort) {
      const budget = REASONING_EFFORT_BUDGET[req.reasoning.effort] ?? 8192;
      body.generationConfig.thinkingConfig = { thinkingBudget: budget };
    }
  }

  return body;
}
