/**
 * Model routes — pure route handlers reading from model-store singleton.
 */

import { Hono } from "hono";
import type { OpenAIModel, OpenAIModelList } from "../types/openai.js";
import {
  getModelCatalog,
  getModelAliases,
  getModelInfo,
  getModelStoreDebug,
  type CodexModelInfo,
} from "../models/model-store.js";

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
    const catalog = getModelCatalog();
    const aliases = getModelAliases();

    // Include catalog models + aliases as separate entries
    const models: OpenAIModel[] = catalog.map(toOpenAIModel);
    for (const alias of Object.keys(aliases)) {
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
    const catalog = getModelCatalog();
    const aliases = getModelAliases();

    // Try direct match
    const info = catalog.find((m) => m.id === modelId);
    if (info) return c.json(toOpenAIModel(info));

    // Try alias
    const resolved = aliases[modelId];
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
    const aliases = getModelAliases();
    const resolved = aliases[modelId] ?? modelId;
    const info = getModelInfo(resolved);
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

  return app;
}
