/**
 * Model routes — pure route handlers reading from model-store singleton.
 */

import { Hono } from "hono";
import type { OpenAIModel, OpenAIModelList } from "../types/openai.js";
import {
  getModelCatalog,
  getModelInfo,
  getModelStoreDebug,
  resolveModelId,
  type CodexModelInfo,
} from "../models/model-store.js";
import { triggerImmediateRefresh } from "../models/model-fetcher.js";
import { toCodexCatalogEntry } from "../models/codex-catalog.js";
import { getConfig } from "../config.js";
import type { ApiKeyPool } from "../auth/api-key-pool.js";
import type { ClientKeyPool } from "../auth/client-key-pool.js";
import { extractProxyApiKey } from "../utils/extract-api-key.js";

// --- Routes ---

/** Stable timestamp used for all model `created` fields (2023-11-14T22:13:20Z). */
const MODEL_CREATED_TIMESTAMP = 1700000000;
const DEFAULT_EFFECTIVE_CONTEXT_WINDOW_PERCENT = 95;
const AUTO_COMPACT_CONTEXT_WINDOW_PERCENT = 80;
const AUTO_COMPACT_TOKEN_LIMIT_OVERRIDES: Record<string, number> = {
  "gpt-5.5": 50_000,
};

function resolvedContextWindow(info: CodexModelInfo): number | undefined {
  return info.contextWindow ?? info.maxContextWindow;
}

function autoCompactTokenLimit(info: CodexModelInfo): number | undefined {
  const override = AUTO_COMPACT_TOKEN_LIMIT_OVERRIDES[info.id];
  if (override !== undefined) return override;
  if (info.autoCompactTokenLimit !== undefined) return info.autoCompactTokenLimit;
  const contextWindow = resolvedContextWindow(info);
  if (contextWindow === undefined) return undefined;
  return Math.floor((contextWindow * AUTO_COMPACT_CONTEXT_WINDOW_PERCENT) / 100);
}

function toOpenAIModel(info: CodexModelInfo): OpenAIModel {
  const model: OpenAIModel = {
    id: info.id,
    object: "model",
    created: MODEL_CREATED_TIMESTAMP,
    owned_by: "openai",
  };

  if (info.contextWindow !== undefined) model.context_window = info.contextWindow;
  if (info.maxContextWindow !== undefined) model.max_context_window = info.maxContextWindow;
  if (info.maxOutputTokens !== undefined) model.max_output_tokens = info.maxOutputTokens;
  if (info.truncationPolicyLimit !== undefined) {
    model.truncation_policy = {
      mode: info.truncationPolicyMode === "bytes" ? "bytes" : "tokens",
      limit: info.truncationPolicyLimit,
    };
  }

  const compactLimit = autoCompactTokenLimit(info);
  if (compactLimit !== undefined) {
    model.auto_compact_token_limit = compactLimit;
  }
  if (info.effectiveContextWindowPercent !== undefined || compactLimit !== undefined) {
    model.effective_context_window_percent =
      info.effectiveContextWindowPercent ?? DEFAULT_EFFECTIVE_CONTEXT_WINDOW_PERCENT;
  }

  // Rich backend metadata (snake_case superset of the OpenAI model object).
  // Static YAML entries may omit collections, so guard before reading them.
  if (info.displayName && info.displayName !== info.id) model.display_name = info.displayName;
  if (info.description) model.description = info.description;
  if (info.defaultReasoningEffort) model.default_reasoning_effort = info.defaultReasoningEffort;
  if (info.supportedReasoningEfforts?.length) {
    model.supported_reasoning_efforts = info.supportedReasoningEfforts.map((effort) => ({
      reasoning_effort: effort.reasoningEffort,
      description: effort.description,
    }));
  }
  if (info.inputModalities?.length) model.input_modalities = info.inputModalities;
  if (info.outputModalities) model.output_modalities = info.outputModalities;
  if (info.serviceTiers) model.service_tiers = info.serviceTiers;
  if (info.defaultServiceTier !== undefined) model.default_service_tier = info.defaultServiceTier;
  if (info.additionalSpeedTiers) model.additional_speed_tiers = info.additionalSpeedTiers;
  if (info.visibility !== undefined) model.visibility = info.visibility;
  if (info.priority !== undefined) model.priority = info.priority;
  if (info.supportedInApi !== undefined) model.supported_in_api = info.supportedInApi;
  if (info.preferWebsockets !== undefined) model.prefer_websockets = info.preferWebsockets;
  if (info.modelSpecialty !== undefined) model.model_specialty = info.modelSpecialty;
  if (info.shellType !== undefined) model.shell_type = info.shellType;
  if (info.toolMode !== undefined) model.tool_mode = info.toolMode;
  if (info.multiAgentVersion !== undefined) model.multi_agent_version = info.multiAgentVersion;
  if (info.multiAgentReasoningEffort !== undefined) {
    model.multi_agent_reasoning_effort = info.multiAgentReasoningEffort;
  }
  if (info.supportVerbosity !== undefined) model.support_verbosity = info.supportVerbosity;
  if (info.defaultVerbosity !== undefined) model.default_verbosity = info.defaultVerbosity;
  if (info.applyPatchToolType !== undefined) model.apply_patch_tool_type = info.applyPatchToolType;
  if (info.webSearchToolType !== undefined) model.web_search_tool_type = info.webSearchToolType;
  if (info.defaultReasoningSummary !== undefined) model.default_reasoning_summary = info.defaultReasoningSummary;
  if (info.supportsReasoningSummaryParameter !== undefined) {
    model.supports_reasoning_summary_parameter = info.supportsReasoningSummaryParameter;
  }
  if (info.compHash !== undefined) model.comp_hash = info.compHash;
  if (info.experimentalSupportedTools) model.experimental_supported_tools = info.experimentalSupportedTools;
  if (info.supportsSearchTool !== undefined) model.supports_search_tool = info.supportsSearchTool;
  if (info.upgrade) model.upgrade = info.upgrade;
  if (info.upgradeInfo) model.upgrade_info = info.upgradeInfo;

  return model;
}

function toRuntimeOpenAIModel(id: string): OpenAIModel {
  return {
    id,
    object: "model",
    created: MODEL_CREATED_TIMESTAMP,
    owned_by: "openai",
  };
}

/** Minimal catalog entry for runtime-discovered models with no backend metadata. */
function toRuntimeCatalogModel(id: string): CodexModelInfo {
  return {
    id,
    displayName: id,
    description: "",
    isDefault: false,
    supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Default" }],
    defaultReasoningEffort: "medium",
    inputModalities: ["text"],
    supportsPersonality: false,
    upgrade: null,
    source: "runtime",
  };
}

export function createModelRoutes(apiKeyPool?: ApiKeyPool, clientKeyPool?: ClientKeyPool): Hono {
  const app = new Hono();

  function getClientKeyAllowedModels(c: import("hono").Context): string[] | null {
    if (!clientKeyPool) return null;
    const token = extractProxyApiKey(c);
    if (!token) return null;
    const key = clientKeyPool.getByKey(token);
    return key?.allowed_models && key.allowed_models.length > 0 ? key.allowed_models : null;
  }

  app.get("/v1/models", (c) => {
    const catalog = getModelCatalog();
    const modelsById = new Map<string, OpenAIModel>();

    for (const model of catalog) {
      modelsById.set(model.id, toOpenAIModel(model));
    }
    for (const modelId of apiKeyPool?.getActiveModels() ?? []) {
      if (!modelsById.has(modelId)) {
        modelsById.set(modelId, toRuntimeOpenAIModel(modelId));
      }
    }

    let data = [...modelsById.values()];
    const allowed = getClientKeyAllowedModels(c);
    if (allowed) {
      data = data.filter((m) => allowed.includes(m.id));
    }

    const response: OpenAIModelList = { object: "list", data };
    return c.json(response);
  });

  // Full catalog with reasoning efforts (for dashboard UI)
  // Must be before :modelId to avoid being matched as a model ID
  app.get("/v1/models/catalog", (c) => {
    let catalog = getModelCatalog();
    const config = getConfig();
    const rawDefault = config.model?.default?.trim();
    const configDefault = rawDefault ? resolveModelId(rawDefault) : undefined;
    const allowed = getClientKeyAllowedModels(c);
    if (allowed) {
      catalog = catalog.filter((m) => allowed.includes(m.id));
    }

    // Default outputModalities to ["text"] for chat-family entries that don't
    // set it explicitly, matching the interface's documented default.
    return c.json(
      catalog.map((m) => ({
        ...m,
        isDefault: configDefault ? m.id === configDefault : m.isDefault,
        outputModalities: m.outputModalities ?? ["text"],
      })),
    );
  });

  // Codex-native rich catalog ({models: [ModelInfo]}) for downstream Codex CLI
  // `model_catalog_url`. Two segments, so :modelId can never shadow it.
  app.get("/v1/models/catalog/codex", (c) => {
    const catalog = getModelCatalog();
    const modelsById = new Map<string, CodexModelInfo>();
    for (const model of catalog) {
      modelsById.set(model.id, model);
    }
    for (const modelId of apiKeyPool?.getActiveModels() ?? []) {
      if (!modelsById.has(modelId)) {
        modelsById.set(modelId, toRuntimeCatalogModel(modelId));
      }
    }

    let data = [...modelsById.values()];
    const allowed = getClientKeyAllowedModels(c);
    if (allowed) {
      data = data.filter((m) => allowed.includes(m.id));
    }

    return c.json({ models: data.map(toCodexCatalogEntry) });
  });

  app.get("/v1/models/:modelId", (c) => {
    const modelId = c.req.param("modelId");
    const allowed = getClientKeyAllowedModels(c);
    if (allowed && !allowed.includes(modelId)) {
      c.status(404);
      return c.json({
        error: {
          message: `Model '${modelId}' not found`,
          type: "invalid_request_error",
          param: "model",
          code: "model_not_found",
        },
      });
    }

    const catalog = getModelCatalog();

    const info = catalog.find((m) => m.id === modelId);
    if (info) return c.json(toOpenAIModel(info));

    if (apiKeyPool?.hasActiveModel(modelId)) {
      return c.json(toRuntimeOpenAIModel(modelId));
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
    const allowed = getClientKeyAllowedModels(c);
    if (allowed && !allowed.includes(modelId)) {
      c.status(404);
      return c.json({ error: `Model '${modelId}' not found` });
    }

    const info = getModelInfo(modelId);
    if (!info) {
      c.status(404);
      return c.json({ error: `Model '${modelId}' not found` });
    }
    return c.json(info);
  });

  // Debug endpoint: model store internals
  app.get("/debug/models", (c) => {
    return c.json(getModelStoreDebug());
  });

  // Admin endpoint: trigger immediate model refresh
  app.post("/admin/refresh-models", (c) => {
    const config = getConfig();
    const configKey = config.server.proxy_api_key;
    if (configKey) {
      const authHeader = c.req.header("Authorization") ?? "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (token !== configKey) {
        c.status(401);
        return c.json({ error: "Unauthorized" });
      }
    }
    triggerImmediateRefresh();
    return c.json({ ok: true, message: "Model refresh triggered" });
  });

  return app;
}
