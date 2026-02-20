/**
 * Anthropic Messages API route handler.
 * POST /v1/messages — compatible with Claude Code CLI and other Anthropic clients.
 */

import { Hono } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import { stream } from "hono/streaming";
import { AnthropicMessagesRequestSchema } from "../types/anthropic.js";
import type { AnthropicErrorBody, AnthropicErrorType } from "../types/anthropic.js";
import type { AccountPool } from "../auth/account-pool.js";
import { CodexApi, CodexApiError } from "../proxy/codex-api.js";
import { SessionManager } from "../session/manager.js";
import { translateAnthropicToCodexRequest } from "../translation/anthropic-to-codex.js";
import {
  streamCodexToAnthropic,
  collectCodexToAnthropicResponse,
  type AnthropicUsageInfo,
} from "../translation/codex-to-anthropic.js";
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
        `[Messages] Retrying after ${err instanceof CodexApiError ? err.status : "error"} (attempt ${attempt + 1}/${maxRetries}, delay ${delay}ms)`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

function makeError(
  type: AnthropicErrorType,
  message: string,
): AnthropicErrorBody {
  return { type: "error", error: { type, message } };
}

/**
 * Extract text from Anthropic message content for session hashing.
 */
function contentToString(
  content: string | Array<{ type: string; text?: string }>,
): string {
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!)
    .join("\n");
}

export function createMessagesRoutes(
  accountPool: AccountPool,
  sessionManager: SessionManager,
  cookieJar?: CookieJar,
): Hono {
  const app = new Hono();

  app.post("/v1/messages", async (c) => {
    // Validate auth — at least one active account
    if (!accountPool.isAuthenticated()) {
      c.status(401);
      return c.json(
        makeError("authentication_error", "Not authenticated. Please login first at /"),
      );
    }

    // Optional proxy API key check
    // Anthropic clients use x-api-key header; also accept Bearer token
    const config = getConfig();
    if (config.server.proxy_api_key) {
      const xApiKey = c.req.header("x-api-key");
      const authHeader = c.req.header("Authorization");
      const bearerKey = authHeader?.replace("Bearer ", "");
      const providedKey = xApiKey ?? bearerKey;

      if (!providedKey || !accountPool.validateProxyApiKey(providedKey)) {
        c.status(401);
        return c.json(makeError("authentication_error", "Invalid API key"));
      }
    }

    // Parse request
    const body = await c.req.json();
    const parsed = AnthropicMessagesRequestSchema.safeParse(body);
    if (!parsed.success) {
      c.status(400);
      return c.json(
        makeError("invalid_request_error", `Invalid request: ${parsed.error.message}`),
      );
    }
    const req = parsed.data;

    // Acquire an account from the pool
    const acquired = accountPool.acquire();
    if (!acquired) {
      c.status(529 as StatusCode);
      return c.json(
        makeError(
          "overloaded_error",
          "No available accounts. All accounts are expired or rate-limited.",
        ),
      );
    }

    const { entryId, token, accountId } = acquired;
    const codexApi = new CodexApi(token, accountId, cookieJar, entryId);

    // Build session-compatible messages for multi-turn lookup
    const sessionMessages: Array<{ role: string; content: string }> = [];
    if (req.system) {
      const sysText =
        typeof req.system === "string"
          ? req.system
          : req.system.map((b) => b.text).join("\n");
      sessionMessages.push({ role: "system", content: sysText });
    }
    for (const msg of req.messages) {
      sessionMessages.push({
        role: msg.role,
        content: contentToString(msg.content),
      });
    }

    const existingSession = sessionManager.findSession(sessionMessages);
    const previousResponseId = existingSession?.responseId ?? null;
    const codexRequest = translateAnthropicToCodexRequest(req, previousResponseId);
    if (previousResponseId) {
      console.log(
        `[Messages] Account ${entryId} | Multi-turn: previous_response_id=${previousResponseId}`,
      );
    }
    console.log(
      `[Messages] Account ${entryId} | Codex request:`,
      JSON.stringify(codexRequest).slice(0, 300),
    );

    let usageInfo: AnthropicUsageInfo | undefined;

    try {
      const rawResponse = await withRetry(() => codexApi.createResponse(codexRequest));

      if (req.stream) {
        c.header("Content-Type", "text/event-stream");
        c.header("Cache-Control", "no-cache");
        c.header("Connection", "keep-alive");

        return stream(c, async (s) => {
          let sessionTaskId: string | null = null;
          try {
            for await (const chunk of streamCodexToAnthropic(
              codexApi,
              rawResponse,
              req.model, // Echo back the model name the client sent
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
        const result = await collectCodexToAnthropicResponse(
          codexApi,
          rawResponse,
          req.model,
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
          `[Messages] Account ${entryId} | Codex API error:`,
          err.message,
        );
        if (err.status === 429) {
          accountPool.markRateLimited(entryId);
          c.status(429);
          return c.json(makeError("rate_limit_error", err.message));
        }
        accountPool.release(entryId);
        const code = (
          err.status >= 400 && err.status < 600 ? err.status : 502
        ) as StatusCode;
        c.status(code);
        return c.json(makeError("api_error", err.message));
      }
      accountPool.release(entryId);
      throw err;
    }
  });

  return app;
}
