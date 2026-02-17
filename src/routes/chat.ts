import { Hono } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import { stream } from "hono/streaming";
import { ChatCompletionRequestSchema } from "../types/openai.js";
import type { AccountPool } from "../auth/account-pool.js";
import { CodexApi, CodexApiError } from "../proxy/codex-api.js";
import { SessionManager } from "../session/manager.js";
import { translateToCodexRequest } from "../translation/openai-to-codex.js";
import {
  streamCodexToOpenAI,
  collectCodexResponse,
  type UsageInfo,
} from "../translation/codex-to-openai.js";
import { getConfig } from "../config.js";
import type { CookieJar } from "../proxy/cookie-jar.js";

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
        `[Chat] Retrying after ${err instanceof CodexApiError ? err.status : "error"} (attempt ${attempt + 1}/${maxRetries}, delay ${delay}ms)`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

export function createChatRoutes(
  accountPool: AccountPool,
  sessionManager: SessionManager,
  cookieJar?: CookieJar,
): Hono {
  const app = new Hono();

  app.post("/v1/chat/completions", async (c) => {
    // Validate auth — at least one active account
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

    // Optional proxy API key check
    const config = getConfig();
    if (config.server.proxy_api_key) {
      const authHeader = c.req.header("Authorization");
      const providedKey = authHeader?.replace("Bearer ", "");
      if (
        !providedKey ||
        !accountPool.validateProxyApiKey(providedKey)
      ) {
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

    // Acquire an account from the pool
    const acquired = accountPool.acquire();
    if (!acquired) {
      c.status(503);
      return c.json({
        error: {
          message: "No available accounts. All accounts are expired or rate-limited.",
          type: "server_error",
          param: null,
          code: "no_available_accounts",
        },
      });
    }

    const { entryId, token, accountId } = acquired;
    const codexApi = new CodexApi(token, accountId, cookieJar, entryId);
    const codexRequest = translateToCodexRequest(req);
    console.log(
      `[Chat] Account ${entryId} | Codex request:`,
      JSON.stringify(codexRequest).slice(0, 300),
    );

    let usageInfo: UsageInfo | undefined;

    try {
      const rawResponse = await withRetry(() => codexApi.createResponse(codexRequest));

      if (req.stream) {
        c.header("Content-Type", "text/event-stream");
        c.header("Cache-Control", "no-cache");
        c.header("Connection", "keep-alive");

        return stream(c, async (s) => {
          try {
            for await (const chunk of streamCodexToOpenAI(
              codexApi,
              rawResponse,
              codexRequest.model,
              (u) => { usageInfo = u; },
            )) {
              await s.write(chunk);
            }
          } finally {
            accountPool.release(entryId, usageInfo);
          }
        });
      } else {
        const result = await collectCodexResponse(
          codexApi,
          rawResponse,
          codexRequest.model,
        );
        accountPool.release(entryId, result.usage);
        return c.json(result.response);
      }
    } catch (err) {
      if (err instanceof CodexApiError) {
        console.error(`[Chat] Account ${entryId} | Codex API error:`, err.message);
        if (err.status === 429) {
          // Parse Retry-After if present
          accountPool.markRateLimited(entryId);
        } else {
          accountPool.release(entryId);
        }
        const code = (err.status >= 400 && err.status < 600 ? err.status : 502) as StatusCode;
        c.status(code);
        return c.json({
          error: {
            message: err.message,
            type: "server_error",
            param: null,
            code: "codex_api_error",
          },
        });
      }
      accountPool.release(entryId);
      throw err;
    }
  });

  return app;
}
