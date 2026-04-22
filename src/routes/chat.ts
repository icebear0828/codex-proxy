import { Hono } from "hono";
import { ChatCompletionRequestSchema } from "../types/openai.js";
import type { AccountPool } from "../auth/account-pool.js";
import type { CookieJar } from "../proxy/cookie-jar.js";
import type { ProxyPool } from "../proxy/proxy-pool.js";
import { translateToCodexRequest } from "../translation/openai-to-codex.js";
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
  handleDirectRequest,
  type FormatAdapter,
} from "./shared/proxy-handler.js";
import type { UpstreamRouter } from "../proxy/upstream-router.js";
import { summarizeRequestForLog } from "../logs/request-summary.js";

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
    streamTranslator: (api, response, model, onUsage, onResponseId, tupleSchema) =>
      streamCodexToOpenAI(api, response, model, onUsage, onResponseId, wantReasoning, tupleSchema),
    collectTranslator: (api, response, model, tupleSchema) =>
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
): Hono {
  const app = new Hono();

  app.post("/v1/chat/completions", async (c) => {
    // Parse request
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      c.status(400);
      return c.json({
        error: {
          message: "Malformed JSON request body",
          type: "invalid_request_error",
          param: null,
          code: "invalid_json",
        },
      });
    }
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
    const routeMatch = upstreamRouter?.resolveMatch(req.model) ?? (isRecognizedModelName(req.model)
      ? { kind: "codex" as const }
      : { kind: "not-found" as const });

    if (routeMatch.kind === "not-found") {
      c.status(404);
      return c.json(formatModelNotFound(req.model));
    }

    const wantReasoning = !!req.reasoning_effort;
    const fmt = makeOpenAIFormat(wantReasoning);
    const { codexRequest, tupleSchema } = translateToCodexRequest(req);
    const displayModel = buildDisplayModelName(parseModelName(req.model));
    const proxyReq = {
      codexRequest,
      model: displayModel,
      isStreaming: req.stream,
      tupleSchema,
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
      const directReq = {
        ...proxyReq,
        model: req.model,
        codexRequest: { ...codexRequest, model: req.model },
      };
      return handleDirectRequest(c, routeMatch.adapter, directReq, fmt);
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
      return handleProxyRequest(c, accountPool, cookieJar, proxyReq, fmt, proxyPool);
    }

    const config = getConfig();
    if (config.server.proxy_api_key) {
      const authHeader = c.req.header("Authorization");
      const providedKey = authHeader?.replace("Bearer ", "");
      if (!providedKey || !accountPool.validateProxyApiKey(providedKey)) {
        c.status(401);
        return c.json({
          error: {
            message: "Invalid proxy API key",
            type: "invalid_request_error",
            param: null,
            code: "invalid_api_key",
          },
        });
      }
    }

    return handleProxyRequest(c, accountPool, cookieJar, proxyReq, fmt, proxyPool);
  });

  return app;
}
