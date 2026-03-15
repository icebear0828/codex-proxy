/**
 * Anthropic Messages API route handler.
 * POST /v1/messages — compatible with Claude Code CLI and other Anthropic clients.
 */

import { Hono } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import { AnthropicMessagesRequestSchema } from "../types/anthropic.js";
import type { AnthropicErrorBody, AnthropicErrorType } from "../types/anthropic.js";
import type { AccountPool } from "../auth/account-pool.js";
import type { CookieJar } from "../proxy/cookie-jar.js";
import type { ProxyPool } from "../proxy/proxy-pool.js";
import { translateAnthropicToCodexRequest } from "../translation/anthropic-to-codex.js";
import {
  streamCodexToAnthropic,
  collectCodexToAnthropicResponse,
} from "../translation/codex-to-anthropic.js";
import { getConfig } from "../config.js";
import { parseModelName, buildDisplayModelName } from "../models/model-store.js";
import {
  handleProxyRequest,
  type FormatAdapter,
} from "./shared/proxy-handler.js";
import {
  ANTHROPIC_PROXY_KEY_SOURCES,
  extractProxyApiKey,
} from "./shared/proxy-auth.js";

function makeError(
  type: AnthropicErrorType,
  message: string,
): AnthropicErrorBody {
  return { type: "error", error: { type, message } };
}

function makeAnthropicFormat(wantThinking: boolean): FormatAdapter {
  return {
    tag: "Messages",
    noAccountStatus: 529 as StatusCode,
    formatNoAccount: () =>
      makeError(
        "overloaded_error",
        "No available accounts. All accounts are expired or rate-limited.",
      ),
    format429: (msg) => makeError("rate_limit_error", msg),
    formatError: (_status, msg) => makeError("api_error", msg),
    streamTranslator: (api, response, model, onUsage, onResponseId) =>
      streamCodexToAnthropic(api, response, model, onUsage, onResponseId, wantThinking),
    collectTranslator: (api, response, model) =>
      collectCodexToAnthropicResponse(api, response, model, wantThinking),
  };
}

export function createMessagesRoutes(
  accountPool: AccountPool,
  cookieJar?: CookieJar,
  proxyPool?: ProxyPool,
): Hono {
  const app = new Hono();

  app.post("/v1/messages", async (c) => {
    // Auth check
    if (!accountPool.isAuthenticated()) {
      c.status(401);
      return c.json(
        makeError("authentication_error", "Not authenticated. Please login first at /"),
      );
    }

    // Optional proxy API key check (x-api-key or Bearer token)
    const config = getConfig();
    if (config.server.proxy_api_key) {
      const providedKey = extractProxyApiKey(c.req, ANTHROPIC_PROXY_KEY_SOURCES);

      if (!providedKey || !accountPool.validateProxyApiKey(providedKey)) {
        c.status(401);
        return c.json(makeError("authentication_error", "Invalid API key"));
      }
    }

    // Parse request
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      c.status(400);
      return c.json(
        makeError("invalid_request_error", "Invalid JSON in request body"),
      );
    }
    const parsed = AnthropicMessagesRequestSchema.safeParse(body);
    if (!parsed.success) {
      c.status(400);
      return c.json(
        makeError("invalid_request_error", `Invalid request: ${parsed.error.message}`),
      );
    }
    const req = parsed.data;

    const codexRequest = translateAnthropicToCodexRequest(req);
    const wantThinking = req.thinking?.type === "enabled" || req.thinking?.type === "adaptive";

    return handleProxyRequest(
      c,
      accountPool,
      cookieJar,
      {
        codexRequest,
        model: buildDisplayModelName(parseModelName(req.model)),
        isStreaming: req.stream,
      },
      makeAnthropicFormat(wantThinking),
      proxyPool,
    );
  });

  return app;
}
