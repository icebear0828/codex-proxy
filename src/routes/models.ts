import { Hono } from "hono";
import { getConfig } from "../config.js";
import type { OpenAIModel, OpenAIModelList } from "../types/openai.js";

const app = new Hono();

/**
 * Full model catalog from Codex CLI `model/list`.
 * Each model has reasoning effort levels, description, and capabilities.
 */
export interface CodexModelInfo {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
  defaultReasoningEffort: string;
  inputModalities: string[];
  supportsPersonality: boolean;
  upgrade: string | null;
}

// Static model catalog — sourced from `codex app-server` model/list
const MODEL_CATALOG: CodexModelInfo[] = [
  {
    id: "gpt-5.3-codex",
    model: "gpt-5.3-codex",
    displayName: "gpt-5.3-codex",
    description: "Latest frontier agentic coding model.",
    isDefault: true,
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Fast responses with lighter reasoning" },
      { reasoningEffort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
      { reasoningEffort: "high", description: "Greater reasoning depth for complex problems" },
      { reasoningEffort: "xhigh", description: "Extra high reasoning depth for complex problems" },
    ],
    defaultReasoningEffort: "medium",
    inputModalities: ["text", "image"],
    supportsPersonality: true,
    upgrade: null,
  },
  {
    id: "gpt-5.2-codex",
    model: "gpt-5.2-codex",
    displayName: "gpt-5.2-codex",
    description: "Frontier agentic coding model.",
    isDefault: false,
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Fast responses with lighter reasoning" },
      { reasoningEffort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
      { reasoningEffort: "high", description: "Greater reasoning depth for complex problems" },
      { reasoningEffort: "xhigh", description: "Extra high reasoning depth for complex problems" },
    ],
    defaultReasoningEffort: "medium",
    inputModalities: ["text", "image"],
    supportsPersonality: true,
    upgrade: "gpt-5.3-codex",
  },
  {
    id: "gpt-5.1-codex-max",
    model: "gpt-5.1-codex-max",
    displayName: "gpt-5.1-codex-max",
    description: "Codex-optimized flagship for deep and fast reasoning.",
    isDefault: false,
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Fast responses with lighter reasoning" },
      { reasoningEffort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
      { reasoningEffort: "high", description: "Greater reasoning depth for complex problems" },
      { reasoningEffort: "xhigh", description: "Extra high reasoning depth for complex problems" },
    ],
    defaultReasoningEffort: "medium",
    inputModalities: ["text", "image"],
    supportsPersonality: false,
    upgrade: "gpt-5.3-codex",
  },
  {
    id: "gpt-5.2",
    model: "gpt-5.2",
    displayName: "gpt-5.2",
    description: "Latest frontier model with improvements across knowledge, reasoning and coding.",
    isDefault: false,
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Balances speed with some reasoning" },
      { reasoningEffort: "medium", description: "Solid balance of reasoning depth and latency" },
      { reasoningEffort: "high", description: "Maximizes reasoning depth for complex problems" },
      { reasoningEffort: "xhigh", description: "Extra high reasoning for complex problems" },
    ],
    defaultReasoningEffort: "medium",
    inputModalities: ["text", "image"],
    supportsPersonality: false,
    upgrade: "gpt-5.3-codex",
  },
  {
    id: "gpt-5.1-codex-mini",
    model: "gpt-5.1-codex-mini",
    displayName: "gpt-5.1-codex-mini",
    description: "Optimized for codex. Cheaper, faster, but less capable.",
    isDefault: false,
    supportedReasoningEfforts: [
      { reasoningEffort: "medium", description: "Dynamically adjusts reasoning based on the task" },
      { reasoningEffort: "high", description: "Maximizes reasoning depth for complex problems" },
    ],
    defaultReasoningEffort: "medium",
    inputModalities: ["text", "image"],
    supportsPersonality: false,
    upgrade: "gpt-5.3-codex",
  },
];

// Short aliases for convenience
const MODEL_ALIASES: Record<string, string> = {
  codex: "gpt-5.3-codex",
  "codex-max": "gpt-5.1-codex-max",
  "codex-mini": "gpt-5.1-codex-mini",
};

/**
 * Resolve a model name (may be an alias) to a canonical model ID.
 */
export function resolveModelId(input: string): string {
  const trimmed = input.trim();
  if (MODEL_ALIASES[trimmed]) return MODEL_ALIASES[trimmed];
  // Check if it's already a known model ID
  if (MODEL_CATALOG.some((m) => m.id === trimmed)) return trimmed;
  // Fall back to config default
  return getConfig().model.default;
}

/**
 * Get model info by ID.
 */
export function getModelInfo(modelId: string): CodexModelInfo | undefined {
  return MODEL_CATALOG.find((m) => m.id === modelId);
}

/**
 * Get the full model catalog.
 */
export function getModelCatalog(): CodexModelInfo[] {
  return MODEL_CATALOG;
}

// --- Routes ---

function toOpenAIModel(info: CodexModelInfo): OpenAIModel {
  return {
    id: info.id,
    object: "model",
    created: 1700000000,
    owned_by: "openai",
  };
}

app.get("/v1/models", (c) => {
  // Include catalog models + aliases as separate entries
  const models: OpenAIModel[] = MODEL_CATALOG.map(toOpenAIModel);
  for (const [alias, target] of Object.entries(MODEL_ALIASES)) {
    models.push({
      id: alias,
      object: "model",
      created: 1700000000,
      owned_by: "openai",
    });
  }
  const response: OpenAIModelList = { object: "list", data: models };
  return c.json(response);
});

app.get("/v1/models/:modelId", (c) => {
  const modelId = c.req.param("modelId");

  // Try direct match
  const info = MODEL_CATALOG.find((m) => m.id === modelId);
  if (info) return c.json(toOpenAIModel(info));

  // Try alias
  const resolved = MODEL_ALIASES[modelId];
  if (resolved) {
    return c.json({
      id: modelId,
      object: "model",
      created: 1700000000,
      owned_by: "openai",
    });
  }

  c.status(404);
  return c.json({
    error: {
      message: `Model '${modelId}' not found`,
      type: "invalid_request_error",
      param: "model",
      code: "model_not_found",
    },
  });
});

// Extended endpoint: model details with reasoning efforts
app.get("/v1/models/:modelId/info", (c) => {
  const modelId = c.req.param("modelId");
  const resolved = MODEL_ALIASES[modelId] ?? modelId;
  const info = MODEL_CATALOG.find((m) => m.id === resolved);
  if (!info) {
    c.status(404);
    return c.json({ error: `Model '${modelId}' not found` });
  }
  return c.json(info);
});

export default app;
