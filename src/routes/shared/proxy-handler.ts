/**
 * Shared proxy handler — encapsulates the account acquire → retry → stream/collect → release
 * lifecycle that is common to all API format routes (OpenAI, Anthropic, Gemini).
 *
 * Each route provides its own schema parsing, auth checking, and format adapter.
 * This handler takes over once a CodexResponsesRequest is prepared.
 */

import type { Context } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import { stream } from "hono/streaming";
import { randomUUID } from "crypto";
import { CodexApi, CodexApiError } from "../../proxy/codex-api.js";
import type { CodexResponsesRequest } from "../../proxy/codex-api.js";
import type { AccountPool } from "../../auth/account-pool.js";
import type { SessionManager } from "../../session/manager.js";
import type { CookieJar } from "../../proxy/cookie-jar.js";
import { withRetry } from "../../utils/retry.js";

/** Data prepared by each route after parsing and translating the request. */
export interface ProxyRequest {
  codexRequest: CodexResponsesRequest;
  sessionMessages: Array<{ role: string; content: string }>;
  model: string;
  isStreaming: boolean;
}

/** Format-specific adapter provided by each route. */
export interface FormatAdapter {
  tag: string;
  noAccountStatus: StatusCode;
  formatNoAccount: () => unknown;
  format429: (message: string) => unknown;
  formatError: (status: number, message: string) => unknown;
  streamTranslator: (
    api: CodexApi,
    response: Response,
    model: string,
    onUsage: (u: { input_tokens: number; output_tokens: number }) => void,
    onResponseId: (id: string) => void,
  ) => AsyncGenerator<string>;
  collectTranslator: (
    api: CodexApi,
    response: Response,
    model: string,
  ) => Promise<{
    response: unknown;
    usage: { input_tokens: number; output_tokens: number };
    responseId: string | null;
  }>;
}

/**
 * Core shared handler — from account acquire to release.
 *
 * Handles: acquire, session lookup, retry, stream/collect, release, error formatting.
 */
export async function handleProxyRequest(
  c: Context,
  accountPool: AccountPool,
  sessionManager: SessionManager,
  cookieJar: CookieJar | undefined,
  req: ProxyRequest,
  fmt: FormatAdapter,
): Promise<Response> {
  // 1. Acquire account
  const acquired = accountPool.acquire();
  if (!acquired) {
    c.status(fmt.noAccountStatus);
    return c.json(fmt.formatNoAccount());
  }

  const { entryId, token, accountId } = acquired;
  const codexApi = new CodexApi(token, accountId, cookieJar, entryId);

  // 2. Session lookup for multi-turn
  const existingSession = sessionManager.findSession(req.sessionMessages);
  const previousResponseId = existingSession?.responseId ?? null;
  if (previousResponseId) {
    req.codexRequest.previous_response_id = previousResponseId;
    console.log(
      `[${fmt.tag}] Account ${entryId} | Multi-turn: previous_response_id=${previousResponseId}`,
    );
  }
  console.log(
    `[${fmt.tag}] Account ${entryId} | Codex request:`,
    JSON.stringify(req.codexRequest).slice(0, 300),
  );

  let usageInfo: { input_tokens: number; output_tokens: number } | undefined;

  try {
    // 3. Retry + send to Codex
    const rawResponse = await withRetry(
      () => codexApi.createResponse(req.codexRequest),
      { tag: fmt.tag },
    );

    // 4. Stream or collect
    if (req.isStreaming) {
      c.header("Content-Type", "text/event-stream");
      c.header("Cache-Control", "no-cache");
      c.header("Connection", "keep-alive");

      return stream(c, async (s) => {
        let sessionTaskId: string | null = null;
        try {
          for await (const chunk of fmt.streamTranslator(
            codexApi,
            rawResponse,
            req.model,
            (u) => {
              usageInfo = u;
            },
            (respId) => {
              if (!sessionTaskId) {
                sessionTaskId = `task-${randomUUID()}`;
                sessionManager.storeSession(
                  sessionTaskId,
                  "turn-1",
                  req.sessionMessages,
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
      const result = await fmt.collectTranslator(
        codexApi,
        rawResponse,
        req.model,
      );
      if (result.responseId) {
        const taskId = `task-${randomUUID()}`;
        sessionManager.storeSession(
          taskId,
          "turn-1",
          req.sessionMessages,
        );
        sessionManager.updateResponseId(taskId, result.responseId);
      }
      accountPool.release(entryId, result.usage);
      return c.json(result.response);
    }
  } catch (err) {
    // 5. Error handling with format-specific responses
    if (err instanceof CodexApiError) {
      console.error(
        `[${fmt.tag}] Account ${entryId} | Codex API error:`,
        err.message,
      );
      if (err.status === 429) {
        accountPool.markRateLimited(entryId);
        // Note: markRateLimited releases the lock but does not increment
        // request_count. We intentionally count 429s as requests for
        // accurate load tracking across accounts.
        const entry = accountPool.getEntry(entryId);
        if (entry) {
          entry.usage.request_count++;
          entry.usage.last_used = new Date().toISOString();
        }
        c.status(429);
        return c.json(fmt.format429(err.message));
      }
      accountPool.release(entryId);
      const code = (
        err.status >= 400 && err.status < 600 ? err.status : 502
      ) as StatusCode;
      c.status(code);
      return c.json(fmt.formatError(code, err.message));
    }
    accountPool.release(entryId);
    throw err;
  }
}
