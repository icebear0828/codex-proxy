/**
 * Google Gemini API route handler.
 * POST /v1beta/models/{model}:generateContent — non-streaming
 * POST /v1beta/models/{model}:streamGenerateContent — streaming
 */

import { Hono } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import { stream } from "hono/streaming";
import { GeminiGenerateContentRequestSchema } from "../types/gemini.js";
import type { GeminiErrorResponse } from "../types/gemini.js";
import type { AccountPool } from "../auth/account-pool.js";
import { CodexApi, CodexApiError } from "../proxy/codex-api.js";
import { SessionManager } from "../session/manager.js";
import {
  translateGeminiToCodexRequest,
  geminiContentsToMessages,
} from "../translation/gemini-to-codex.js";
import {
  streamCodexToGemini,
  collectCodexToGeminiResponse,
  type GeminiUsageInfo,
} from "../translation/codex-to-gemini.js";
import { getConfig } from "../config.js";
import type { CookieJar } from "../proxy/cookie-jar.js";
import { resolveModelId } from "./models.js";

/** Retry a function on 5xx errors with exponential backoff. */
async function withRetry<T>(
  fn: () => Promise<T>,
  { maxRetries = 2, baseDelayMs = 1000 }: { maxRetries?: number; baseDelayMs?: number } = {},
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const isRetryable =
        err instanceof CodexApiError && err.status >= 500 && err.status < 600;
      if (!isRetryable || attempt === maxRetries) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt);
      console.warn(
        `[Gemini] Retrying after ${err instanceof CodexApiError ? err.status : "error"} (attempt ${attempt + 1}/${maxRetries}, delay ${delay}ms)`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

const GEMINI_STATUS_MAP: Record<number, string> = {
  400: "INVALID_ARGUMENT",
  401: "UNAUTHENTICATED",
  403: "PERMISSION_DENIED",
  404: "NOT_FOUND",
  429: "RESOURCE_EXHAUSTED",
  500: "INTERNAL",
  502: "INTERNAL",
  503: "UNAVAILABLE",
};

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

    // Validate auth — at least one active account
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

    // Acquire an account from the pool
    const acquired = accountPool.acquire();
    if (!acquired) {
      c.status(503);
      return c.json(
        makeError(
          503,
          "No available accounts. All accounts are expired or rate-limited.",
          "UNAVAILABLE",
        ),
      );
    }

    const { entryId, token, accountId } = acquired;
    const codexApi = new CodexApi(token, accountId, cookieJar, entryId);

    // Session lookup for multi-turn
    const sessionMessages = geminiContentsToMessages(
      req.contents,
      req.systemInstruction,
    );
    const existingSession = sessionManager.findSession(sessionMessages);
    const previousResponseId = existingSession?.responseId ?? null;

    const codexRequest = translateGeminiToCodexRequest(
      req,
      geminiModel,
      previousResponseId,
    );
    if (previousResponseId) {
      console.log(
        `[Gemini] Account ${entryId} | Multi-turn: previous_response_id=${previousResponseId}`,
      );
    }
    console.log(
      `[Gemini] Account ${entryId} | Model: ${geminiModel} → ${codexRequest.model} | Codex request:`,
      JSON.stringify(codexRequest).slice(0, 300),
    );

    let usageInfo: GeminiUsageInfo | undefined;

    try {
      const rawResponse = await withRetry(() =>
        codexApi.createResponse(codexRequest),
      );

      if (isStreaming) {
        c.header("Content-Type", "text/event-stream");
        c.header("Cache-Control", "no-cache");
        c.header("Connection", "keep-alive");

        return stream(c, async (s) => {
          let sessionTaskId: string | null = null;
          try {
            for await (const chunk of streamCodexToGemini(
              codexApi,
              rawResponse,
              geminiModel,
              (u) => {
                usageInfo = u;
              },
              (respId) => {
                if (!sessionTaskId) {
                  sessionTaskId = `task-${Date.now()}`;
                  sessionManager.storeSession(
                    sessionTaskId,
                    "turn-1",
                    sessionMessages,
                  );
                }
                sessionManager.updateResponseId(sessionTaskId, respId);
              },
            )) {
              await s.write(chunk);
            }
          } finally {
            accountPool.release(entryId, usageInfo);
          }
        });
      } else {
        const result = await collectCodexToGeminiResponse(
          codexApi,
          rawResponse,
          geminiModel,
        );
        if (result.responseId) {
          const taskId = `task-${Date.now()}`;
          sessionManager.storeSession(taskId, "turn-1", sessionMessages);
          sessionManager.updateResponseId(taskId, result.responseId);
        }
        accountPool.release(entryId, result.usage);
        return c.json(result.response);
      }
    } catch (err) {
      if (err instanceof CodexApiError) {
        console.error(
          `[Gemini] Account ${entryId} | Codex API error:`,
          err.message,
        );
        if (err.status === 429) {
          accountPool.markRateLimited(entryId);
          c.status(429);
          return c.json(makeError(429, err.message, "RESOURCE_EXHAUSTED"));
        }
        accountPool.release(entryId);
        const code = (
          err.status >= 400 && err.status < 600 ? err.status : 502
        ) as StatusCode;
        c.status(code);
        return c.json(makeError(code, err.message));
      }
      accountPool.release(entryId);
      throw err;
    }
  });

  // List available Gemini models
  app.get("/v1beta/models", (c) => {
    // Import aliases from models.yaml and filter Gemini ones
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
