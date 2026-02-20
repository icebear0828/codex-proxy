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
import type { SessionManager } from "../session/manager.js";
import type { CookieJar } from "../proxy/cookie-jar.js";
import {
  translateGeminiToCodexRequest,
  geminiContentsToMessages,
} from "../translation/gemini-to-codex.js";
import {
  streamCodexToGemini,
  collectCodexToGeminiResponse,
} from "../translation/codex-to-gemini.js";
import { getConfig } from "../config.js";
import { resolveModelId } from "./models.js";
import {
  handleProxyRequest,
  type FormatAdapter,
} from "./shared/proxy-handler.js";

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
  streamTranslator: streamCodexToGemini,
  collectTranslator: collectCodexToGeminiResponse,
};

export function createGeminiRoutes(
  accountPool: AccountPool,
  sessionManager: SessionManager,
  cookieJar?: CookieJar,
): Hono {
  const app = new Hono();

  // Handle both generateContent and streamGenerateContent
  app.post("/v1beta/models/:modelAction", async (c) => {
    const modelActionParam = c.req.param("modelAction");
    const parsed = parseModelAction(modelActionParam);

    if (
      !parsed ||
      (parsed.action !== "generateContent" &&
        parsed.action !== "streamGenerateContent")
    ) {
      c.status(400);
      return c.json(
        makeError(
          400,
          `Invalid action. Expected :generateContent or :streamGenerateContent, got: ${modelActionParam}`,
        ),
      );
    }

    const { model: geminiModel, action } = parsed;
    const isStreaming =
      action === "streamGenerateContent" ||
      c.req.query("alt") === "sse";

    // Auth check
    if (!accountPool.isAuthenticated()) {
      c.status(401);
      return c.json(
        makeError(401, "Not authenticated. Please login first at /"),
      );
    }

    // API key check: query param ?key= or header x-goog-api-key
    const config = getConfig();
    if (config.server.proxy_api_key) {
      const queryKey = c.req.query("key");
      const headerKey = c.req.header("x-goog-api-key");
      const authHeader = c.req.header("Authorization");
      const bearerKey = authHeader?.replace("Bearer ", "");
      const providedKey = queryKey ?? headerKey ?? bearerKey;

      if (!providedKey || !accountPool.validateProxyApiKey(providedKey)) {
        c.status(401);
        return c.json(makeError(401, "Invalid API key"));
      }
    }

    // Parse request
    const body = await c.req.json();
    const validationResult = GeminiGenerateContentRequestSchema.safeParse(body);
    if (!validationResult.success) {
      c.status(400);
      return c.json(
        makeError(400, `Invalid request: ${validationResult.error.message}`),
      );
    }
    const req = validationResult.data;

    // Session lookup for multi-turn
    const sessionMessages = geminiContentsToMessages(
      req.contents,
      req.systemInstruction,
    );

    const codexRequest = translateGeminiToCodexRequest(
      req,
      geminiModel,
    );

    console.log(
      `[Gemini] Model: ${geminiModel} → ${codexRequest.model}`,
    );

    return handleProxyRequest(
      c,
      accountPool,
      sessionManager,
      cookieJar,
      {
        codexRequest,
        sessionMessages,
        model: geminiModel,
        isStreaming,
      },
      GEMINI_FORMAT,
    );
  });

  // List available Gemini models
  app.get("/v1beta/models", (c) => {
    const geminiAliases = [
      "gemini-2.5-pro",
      "gemini-2.5-pro-preview",
      "gemini-2.5-flash",
      "gemini-2.0-flash",
    ];

    const models = geminiAliases.map((name) => ({
      name: `models/${name}`,
      displayName: name,
      description: `Proxy alias for ${resolveModelId(name)}`,
      supportedGenerationMethods: [
        "generateContent",
        "streamGenerateContent",
      ],
    }));

    return c.json({ models });
  });

  return app;
}
