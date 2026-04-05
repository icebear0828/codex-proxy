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

interface GeminiTextPart { text: string }
interface GeminiInlineDataPart { inlineData: { mimeType: string; data: string } }
interface GeminiFunctionCallPart { functionCall: { name: string; args: unknown } }
interface GeminiFunctionResponsePart { functionResponse: { name: string; response: unknown } }

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

export interface GeminiGenerateContentRequest {
  contents: GeminiContent[];
  system_instruction?: { parts: [{ text: string }] };
  tools?: GeminiTool[];
  generationConfig?: {
    responseMimeType?: string;
    responseSchema?: unknown;
    thinkingConfig?: { thinkingBudget: number };
  };
}

function codexPartToGemini(part: CodexContentPart): GeminiPart {
  if (part.type === "input_text") return { text: part.text };
  // input_image — treat as external URL reference via text (Gemini Files API not used here)
  return { text: `[Image: ${part.image_url}]` };
}

function inputItemsToGeminiContents(input: CodexInputItem[]): GeminiContent[] {
  const contents: GeminiContent[] = [];

  for (const item of input) {
    if ("role" in item) {
      const role = item.role;
      if (role === "system") continue; // handled by system_instruction
      const geminiRole = role === "assistant" ? "model" as const : "user" as const;

      if (typeof item.content === "string") {
        contents.push({ role: geminiRole, parts: [{ text: item.content }] });
      } else {
        contents.push({ role: geminiRole, parts: item.content.map(codexPartToGemini) });
      }
    } else if (item.type === "function_call") {
      const fnCallPart: GeminiFunctionCallPart = {
        functionCall: {
          name: item.name,
          args: (() => {
            try { return JSON.parse(item.arguments) as unknown; } catch { return {}; }
          })(),
        },
      };
      const last = contents.at(-1);
      if (last?.role === "model") {
        last.parts.push(fnCallPart);
      } else {
        contents.push({ role: "model", parts: [fnCallPart] });
      }
    } else if (item.type === "function_call_output") {
      const fnRespPart: GeminiFunctionResponsePart = {
        functionResponse: {
          name: "",  // Gemini doesn't require name on response; use empty
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
      "function" in tool
    ) {
      const fn = (tool as { function: { name: string; description?: string; parameters?: unknown } }).function;
      declarations.push({ name: fn.name, description: fn.description, parameters: fn.parameters });
    }
  }
  return declarations.length ? [{ functionDeclarations: declarations }] : [];
}

const REASONING_BUDGET: Record<string, number> = {
  low: 1024,
  medium: 8192,
  high: 16000,
  xhigh: 32000,
};

export function translateCodexToGeminiRequest(
  req: CodexResponsesRequest,
): GeminiGenerateContentRequest {
  const contents = inputItemsToGeminiContents(req.input);

  const body: GeminiGenerateContentRequest = { contents };

  if (req.instructions) {
    body.system_instruction = { parts: [{ text: req.instructions }] };
  }

  if (req.tools?.length) {
    body.tools = convertToolsToGemini(req.tools);
  }

  if (req.text?.format || req.reasoning?.effort) {
    body.generationConfig = {};
    if (req.text?.format?.type === "json_object") {
      body.generationConfig.responseMimeType = "application/json";
    } else if (req.text?.format?.type === "json_schema" && req.text.format.schema) {
      body.generationConfig.responseMimeType = "application/json";
      body.generationConfig.responseSchema = req.text.format.schema;
    }
    if (req.reasoning?.effort) {
      const budget = REASONING_BUDGET[req.reasoning.effort] ?? 8192;
      body.generationConfig.thinkingConfig = { thinkingBudget: budget };
    }
  }

  return body;
}
