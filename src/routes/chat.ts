import { Hono } from "hono";
import type { Context } from "hono";
import { ChatCompletionRequestSchema } from "../types/openai.js";
import type { AccountPool } from "../auth/account-pool.js";
import type { CookieJar } from "../proxy/cookie-jar.js";
import type { ProxyPool } from "../proxy/proxy-pool.js";
import { translateToCodexRequest } from "../translation/openai-to-codex.js";
import { isRecord } from "../translation/shared-utils.js";
import {
  streamCodexToOpenAI,
  collectCodexResponse,
} from "../translation/codex-to-openai.js";
import { getConfig } from "../config.js";
import {
  parseModelName,
  buildDisplayModelName,
  isRecognizedModelName,
} from "../models/model-store.js";
import { enqueueLogEntry } from "../logs/entry.js";
import { getRealClientIp } from "../utils/get-real-client-ip.js";
import { randomUUID } from "crypto";
import {
  handleProxyRequest,
} from "./shared/proxy-handler.js";
import { handleDirectRequest } from "./shared/direct-request-handler.js";
import type { FormatAdapter, ProxyRequest } from "./shared/proxy-handler-types.js";
import type { UpstreamRouter } from "../proxy/upstream-router.js";
import { summarizeRequestForLog } from "../logs/request-summary.js";
import { apiKeyAuth } from "../middleware/api-key-auth.js";
import type { ClientKeyPool } from "../auth/client-key-pool.js";
import { validateClientKeyModel } from "./shared/proxy-handler-utils.js";
import { resolveDefaultTools, mergeDefaultTools } from "./shared/default-tools.js";

function makeOpenAIFormat(wantReasoning: boolean): FormatAdapter {
  return {
    tag: "Chat",
    noAccountStatus: 503,
    formatNoAccount: () => ({
      error: {
        message:
          "No available accounts. All accounts are expired or rate-limited.",
        type: "server_error",
        param: null,
        code: "no_available_accounts",
      },
    }),
    format429: (msg) => ({
      error: {
        message: msg,
        type: "rate_limit_error",
        param: null,
        code: "rate_limit_exceeded",
      },
    }),
    formatError: (_status, msg) => ({
      error: {
        message: msg,
        type: "server_error",
        param: null,
        code: "codex_api_error",
      },
    }),
    streamTranslator: ({ api, response, model, onUsage, onResponseId, onResponseCompleted, tupleSchema }) =>
      streamCodexToOpenAI(api, response, model, onUsage, onResponseId, wantReasoning, tupleSchema, onResponseCompleted),
    collectTranslator: ({ api, response, model, tupleSchema }) =>
      collectCodexResponse(api, response, model, wantReasoning, tupleSchema),
  };
}

function formatModelNotFound(model: string) {
  return {
    error: {
      message: `Model '${model}' not found`,
      type: "invalid_request_error",
      param: "model",
      code: "model_not_found",
    },
  };
}

export function createChatRoutes(
  accountPool: AccountPool,
  cookieJar?: CookieJar,
  proxyPool?: ProxyPool,
  upstreamRouter?: UpstreamRouter,
  clientKeyPool?: ClientKeyPool,
): Hono {
  const app = new Hono();

  app.post("/v1/chat/completions", apiKeyAuth(accountPool, clientKeyPool), async (c) => {
    // Parse request
    const body = await c.req.json();
    const parsed = ChatCompletionRequestSchema.safeParse(body);
    if (!parsed.success) {
      c.status(400);
      return c.json({
        error: {
          message: `Invalid request: ${parsed.error.message}`,
          type: "invalid_request_error",
          param: null,
          code: "invalid_request",
        },
      });
    }
    const req = parsed.data;

    const modelCheck = validateClientKeyModel(c, req.model);
    if (!modelCheck.allowed) {
      c.status(403);
      return c.json({
        error: {
          message: modelCheck.message,
          type: "invalid_request_error",
          param: "model",
          code: "model_not_allowed",
        },
      });
    }
    const routeMatch = upstreamRouter?.resolveMatch(req.model) ?? (isRecognizedModelName(req.model)
      ? { kind: "codex" as const }
      : { kind: "not-found" as const });

    if (routeMatch.kind === "not-found") {
      c.status(404);
      return c.json(formatModelNotFound(req.model));
    }

    const defaultTools = resolveDefaultTools(c, {
      allowUnauthenticated: routeMatch.kind === "api-key" || routeMatch.kind === "adapter",
    });
    if (defaultTools.length > 0) {
      req.tools = mergeDefaultTools(req.tools, defaultTools);
    }

    const { codexRequest, tupleSchema } = translateToCodexRequest(req);
    const expectsImageGen = Array.isArray(codexRequest.tools)
      && codexRequest.tools.some((t): t is Record<string, unknown> => isRecord(t) && t.type === "image_generation");
    // Check after translation so suffix-parsed and config-default effort are included.
    const wantReasoning = !!codexRequest.reasoning?.effort;
    const fmt = makeOpenAIFormat(wantReasoning);
    const displayModel = buildDisplayModelName(parseModelName(req.model));
    const proxyReq: ProxyRequest = {
      codexRequest,
      model: displayModel,
      isStreaming: req.stream ?? false,
      clientConversationId: req.user,
      tupleSchema,
      expectsImageGen,
    };

    const requestId = c.get("requestId") ?? randomUUID().slice(0, 8);
    enqueueLogEntry({
      requestId,
      direction: "ingress",
      method: c.req.method,
      path: c.req.path,
      model: req.model,
      stream: !!req.stream,
      request: summarizeRequestForLog("chat", req, {
        ip: getRealClientIp(c, getConfig()?.server?.trust_proxy ?? false),
        headers: Object.fromEntries(c.req.raw.headers.entries()),
      }),
    });

    if (routeMatch.kind === "api-key" || routeMatch.kind === "adapter") {

      const directModel = routeMatch.resolvedModel ?? req.model;
      const directReq = {
        ...proxyReq,
        model: directModel,
        codexRequest: { ...codexRequest, model: directModel },
      };
      return handleDirectRequest({ c, upstream: routeMatch.adapter, req: directReq, fmt });
    }

    // Auth check for Codex route only
    if (!accountPool.isAuthenticated()) {
      c.status(401);
      return c.json({
        error: {
          message: "Not authenticated. Please login first at /",
          type: "invalid_request_error",
          param: null,
          code: "invalid_api_key",
        },
      });
    }

    const summary = accountPool.getPoolSummary();
    if (summary.active === 0) {
      return handleProxyRequest({ c, accountPool, cookieJar, req: proxyReq, fmt, proxyPool });
    }

    return handleProxyRequest({ c, accountPool, cookieJar, req: proxyReq, fmt, proxyPool });
  });

  return app;
}
