import { Hono } from "hono";
import { readFileSync } from "fs";
import { resolve } from "path";
import yaml from "js-yaml";
import { getConfig } from "../config.js";
import type { OpenAIModel, OpenAIModelList } from "../types/openai.js";

/**
 * Full model catalog from Codex CLI `model/list`.
 * Each model has reasoning effort levels, description, and capabilities.
 */
export interface CodexModelInfo {
  id: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
  defaultReasoningEffort: string;
  inputModalities: string[];
  supportsPersonality: boolean;
  upgrade: string | null;
}

interface ModelsConfig {
  models: CodexModelInfo[];
  aliases: Record<string, string>;
}

function loadModelConfig(): ModelsConfig {
  const configPath = resolve(process.cwd(), "config/models.yaml");
  const raw = yaml.load(readFileSync(configPath, "utf-8")) as ModelsConfig;
  return raw;
}

const modelConfig = loadModelConfig();
const MODEL_CATALOG: CodexModelInfo[] = modelConfig.models;
const MODEL_ALIASES: Record<string, string> = modelConfig.aliases;

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

/** Stable timestamp used for all model `created` fields (2023-11-14T22:13:20Z). */
const MODEL_CREATED_TIMESTAMP = 1700000000;

function toOpenAIModel(info: CodexModelInfo): OpenAIModel {
  return {
    id: info.id,
    object: "model",
    created: MODEL_CREATED_TIMESTAMP,
    owned_by: "openai",
  };
}

export function createModelRoutes(): Hono {
  const app = new Hono();

  app.get("/v1/models", (c) => {
    // Include catalog models + aliases as separate entries
    const models: OpenAIModel[] = MODEL_CATALOG.map(toOpenAIModel);
    for (const [alias] of Object.entries(MODEL_ALIASES)) {
      models.push({
        id: alias,
        object: "model",
        created: MODEL_CREATED_TIMESTAMP,
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
        created: MODEL_CREATED_TIMESTAMP,
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

  return app;
}
