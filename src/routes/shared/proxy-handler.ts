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
import { EmptyResponseError } from "../../translation/codex-event-extractor.js";
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
  // Tracks which account the outer catch should release (updated by retry loop)
  let activeEntryId = entryId;

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

  // P0-2: AbortController to kill curl when client disconnects
  const abortController = new AbortController();
  c.req.raw.signal.addEventListener("abort", () => abortController.abort(), { once: true });

  try {
    // 3. Retry + send to Codex
    const rawResponse = await withRetry(
      () => codexApi.createResponse(req.codexRequest, abortController.signal),
      { tag: fmt.tag },
    );

    // 4. Stream or collect
    if (req.isStreaming) {
      c.header("Content-Type", "text/event-stream");
      c.header("Cache-Control", "no-cache");
      c.header("Connection", "keep-alive");

      return stream(c, async (s) => {
        s.onAbort(() => abortController.abort());
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
        } catch (err) {
          // P2-8: Send error SSE event to client before closing
          try {
            const errMsg = err instanceof Error ? err.message : "Stream interrupted";
            await s.write(`data: ${JSON.stringify({ error: { message: errMsg, type: "stream_error" } })}\n\n`);
          } catch { /* client already gone */ }
          throw err;
        } finally {
          // P0-2: Kill curl subprocess if still running
          abortController.abort();
          accountPool.release(entryId, usageInfo);
        }
      });
    } else {
      // Non-streaming: retry loop for empty responses (switch accounts)
      const MAX_EMPTY_RETRIES = 2;
      let currentEntryId = entryId;
      let currentCodexApi = codexApi;
      let currentRawResponse = rawResponse;

      for (let attempt = 1; ; attempt++) {
        try {
          const result = await fmt.collectTranslator(
            currentCodexApi,
            currentRawResponse,
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
          accountPool.release(currentEntryId, result.usage);
          return c.json(result.response);
        } catch (collectErr) {
          if (collectErr instanceof EmptyResponseError && attempt <= MAX_EMPTY_RETRIES) {
            console.warn(
              `[${fmt.tag}] Account ${currentEntryId} | Empty response (attempt ${attempt}/${MAX_EMPTY_RETRIES + 1}), switching account...`,
            );
            accountPool.release(currentEntryId, collectErr.usage);

            // Acquire a new account
            const newAcquired = accountPool.acquire();
            if (!newAcquired) {
              console.warn(`[${fmt.tag}] No available account for retry`);
              c.status(502);
              return c.json(fmt.formatError(502, "Codex returned an empty response and no other accounts are available for retry"));
            }

            currentEntryId = newAcquired.entryId;
            activeEntryId = currentEntryId;
            currentCodexApi = new CodexApi(newAcquired.token, newAcquired.accountId, cookieJar, newAcquired.entryId);
            try {
              currentRawResponse = await withRetry(
                () => currentCodexApi.createResponse(req.codexRequest, abortController.signal),
                { tag: fmt.tag },
              );
            } catch (retryErr) {
              accountPool.release(currentEntryId);
              if (retryErr instanceof CodexApiError) {
                const code = (retryErr.status >= 400 && retryErr.status < 600 ? retryErr.status : 502) as StatusCode;
                c.status(code);
                return c.json(fmt.formatError(code, retryErr.message));
              }
              throw retryErr;
            }
            continue;
          }

          // Not an empty response error, or retries exhausted
          accountPool.release(currentEntryId);
          if (collectErr instanceof EmptyResponseError) {
            console.warn(
              `[${fmt.tag}] Account ${currentEntryId} | Empty response (attempt ${attempt}/${MAX_EMPTY_RETRIES + 1}), all retries exhausted`,
            );
            c.status(502);
            return c.json(fmt.formatError(502, "Codex returned empty responses across all available accounts"));
          }
          const msg = collectErr instanceof Error ? collectErr.message : "Unknown error";
          c.status(502);
          return c.json(fmt.formatError(502, msg));
        }
      }
    }
  } catch (err) {
    // 5. Error handling with format-specific responses
    if (err instanceof CodexApiError) {
      console.error(
        `[${fmt.tag}] Account ${activeEntryId} | Codex API error:`,
        err.message,
      );
      if (err.status === 429) {
        // P1-6: Count 429s as requests via encapsulated API (no direct entry mutation)
        accountPool.markRateLimited(activeEntryId, { countRequest: true });
        c.status(429);
        return c.json(fmt.format429(err.message));
      }
      accountPool.release(activeEntryId);
      const code = (
        err.status >= 400 && err.status < 600 ? err.status : 502
      ) as StatusCode;
      c.status(code);
      return c.json(fmt.formatError(code, err.message));
    }
    accountPool.release(activeEntryId);
    throw err;
  }
}
