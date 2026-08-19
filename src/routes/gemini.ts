/**
 * Google Gemini API route handler.
 * POST /v1beta/models/{model}:generateContent — non-streaming
 * POST /v1beta/models/{model}:streamGenerateContent — streaming
 */

import { Hono } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import type { GeminiErrorResponse } from "../types/gemini.js";
import { GEMINI_STATUS_MAP } from "../types/gemini.js";
import { GeminiGenerateContentRequestSchema } from "../types/gemini.js";
import type { AccountPool } from "../auth/account-pool.js";
import type { CookieJar } from "../proxy/cookie-jar.js";
import type { ProxyPool } from "../proxy/proxy-pool.js";
import {
  translateGeminiToCodexRequest,
} from "../translation/gemini-to-codex.js";
import {
  streamCodexToGemini,
  collectCodexToGeminiResponse,
} from "../translation/codex-to-gemini.js";
import { getConfig } from "../config.js";
import { apiKeyAuth } from "../middleware/api-key-auth.js";
import { getModelCatalog } from "../models/model-store.js";
import {
  handleProxyRequest,
} from "./shared/proxy-handler.js";
import { handleDirectRequest } from "./shared/direct-request-handler.js";
import type { FormatAdapter, ProxyRequest } from "./shared/proxy-handler-types.js";
import type { UpstreamRouter } from "../proxy/upstream-router.js";
import type { ClientKeyPool } from "../auth/client-key-pool.js";
import { validateClientKeyModel } from "./shared/proxy-handler-utils.js";
import { extractProxyApiKey } from "../utils/extract-api-key.js";
import { resolveDefaultTools, mergeDefaultTools } from "./shared/default-tools.js";

function makeError(
  code: number,
  message: string,
  status?: string,
): GeminiErrorResponse {
  return {
    error: {
      code,
      message,
      status: status ?? GEMINI_STATUS_MAP[code] ?? "INTERNAL",
    },
  };
}

/**
 * Parse model name and action from the URL param.
 * e.g. "gemini-2.5-pro:generateContent" → { model: "gemini-2.5-pro", action: "generateContent" }
 */
function parseModelAction(param: string): {
  model: string;
  action: string;
} | null {
  const lastColon = param.lastIndexOf(":");
  if (lastColon <= 0) return null;
  return {
    model: param.slice(0, lastColon),
    action: param.slice(lastColon + 1),
  };
}

const GEMINI_FORMAT: FormatAdapter = {
  tag: "Gemini",
  noAccountStatus: 503,
  formatNoAccount: () =>
    makeError(
      503,
      "No available accounts. All accounts are expired or rate-limited.",
      "UNAVAILABLE",
    ),
  format429: (msg) => makeError(429, msg, "RESOURCE_EXHAUSTED"),
  formatError: (status, msg) => makeError(status, msg),
  streamTranslator: ({ api, response, model, onUsage, onResponseId, onResponseCompleted, tupleSchema }) =>
    streamCodexToGemini(api, response, model, onUsage, onResponseId, tupleSchema, onResponseCompleted),
  collectTranslator: ({ api, response, model, tupleSchema }) =>
    collectCodexToGeminiResponse(api, response, model, tupleSchema),
};

export function createGeminiRoutes(
  accountPool: AccountPool,
  cookieJar?: CookieJar,
  proxyPool?: ProxyPool,
  upstreamRouter?: UpstreamRouter,
  clientKeyPool?: ClientKeyPool,
): Hono {
  const app = new Hono();

  // Handle both generateContent and streamGenerateContent
  app.post("/v1beta/models/:modelAction", apiKeyAuth(accountPool, clientKeyPool), async (c) => {
    const modelActionParam = c.req.param("modelAction");
    const parsedAction = parseModelAction(modelActionParam);

    if (
      !parsedAction ||
      (parsedAction.action !== "generateContent" &&
        parsedAction.action !== "streamGenerateContent")
    ) {
      c.status(400);
      return c.json(
        makeError(
          400,
          `Invalid action. Expected :generateContent or :streamGenerateContent, got: ${modelActionParam}`,
        ),
      );
    }

    const { model: geminiModel, action } = parsedAction;

    const modelCheck = validateClientKeyModel(c, geminiModel);
    if (!modelCheck.allowed) {
      c.status(403);
      return c.json(makeError(403, "PERMISSION_DENIED", modelCheck.message || "Model not allowed"));
    }

    const routeMatch = upstreamRouter?.resolveMatch(geminiModel);
    const allowUnauthenticated = routeMatch?.kind === "api-key" || routeMatch?.kind === "adapter";

    // Auth check
    if (!allowUnauthenticated && !accountPool.isAuthenticated()) {
      c.status(401);
      return c.json(
        makeError(
          401,
          "Not authenticated. Please login first at /",
          "UNAUTHENTICATED",
        ),
      );
    }

    // Parse body
    const rawBody = await c.req.json();
    const parsed = GeminiGenerateContentRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      c.status(400);
      return c.json(
        makeError(
          400,
          `Invalid request: ${parsed.error.message}`,
          "INVALID_ARGUMENT",
        ),
      );
    }

    const defaultTools = resolveDefaultTools(c, { allowUnauthenticated });
    const { codexRequest, tupleSchema } = translateGeminiToCodexRequest(
      parsed.data,
      geminiModel,
    );
    if (defaultTools.length > 0) {
      codexRequest.tools = mergeDefaultTools(codexRequest.tools, defaultTools);
    }

    console.log(
      `[Gemini] Model: ${geminiModel} → ${codexRequest.model}`,
    );

    const isStreaming =
      action === "streamGenerateContent" ||
      c.req.query("alt") === "sse";

    const proxyReq: ProxyRequest = {
      codexRequest,
      model: geminiModel,
      isStreaming,
      clientConversationId: c.req.header("x-conversation-id") || c.req.header("x-session-id"),
      tupleSchema,
      expectsImageGen: false,
    };

    if (routeMatch?.kind === "api-key" || routeMatch?.kind === "adapter") {
      const directModel = routeMatch.resolvedModel ?? geminiModel;
      const directReq = {
        ...proxyReq,
        model: directModel,
        codexRequest: { ...codexRequest, model: directModel },
      };
      return handleDirectRequest({ c, upstream: routeMatch.adapter, req: directReq, fmt: GEMINI_FORMAT });
    }

    return handleProxyRequest({ c, accountPool, cookieJar, req: proxyReq, fmt: GEMINI_FORMAT, proxyPool });
  });

  // List available models (Gemini format)
  app.get("/v1beta/models", apiKeyAuth(accountPool, clientKeyPool), (c) => {
    let catalog = getModelCatalog();
    const token = extractProxyApiKey(c);
    if (token && clientKeyPool) {
      const clientKey = clientKeyPool.getByKey(token);
      if (clientKey?.allowed_models && clientKey.allowed_models.length > 0) {
        catalog = catalog.filter((m) => clientKey.allowed_models!.includes(m.id));
      }
    }

    const models = catalog.map((m) => ({
      name: `models/${m.id}`,
      displayName: m.displayName,
      description: m.description,
      supportedGenerationMethods: [
        "generateContent",
        "streamGenerateContent",
      ],
    }));

    return c.json({ models });
  });

  return app;
}
