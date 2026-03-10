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
import { CodexApi, CodexApiError } from "../../proxy/codex-api.js";
import type { CodexResponsesRequest } from "../../proxy/codex-api.js";
import { EmptyResponseError } from "../../translation/codex-event-extractor.js";
import type { AccountPool } from "../../auth/account-pool.js";
import type { CookieJar } from "../../proxy/cookie-jar.js";
import type { ProxyPool } from "../../proxy/proxy-pool.js";
import { withRetry } from "../../utils/retry.js";

/** Data prepared by each route after parsing and translating the request. */
export interface ProxyRequest {
  codexRequest: CodexResponsesRequest;
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
    onUsage: (u: { input_tokens: number; output_tokens: number; cached_tokens?: number; reasoning_tokens?: number }) => void,
    onResponseId: (id: string) => void,
  ) => AsyncGenerator<string>;
  collectTranslator: (
    api: CodexApi,
    response: Response,
    model: string,
  ) => Promise<{
    response: unknown;
    usage: { input_tokens: number; output_tokens: number; cached_tokens?: number; reasoning_tokens?: number };
    responseId: string | null;
  }>;
}

/**
 * Core shared handler — from account acquire to release.
 *
 * Handles: acquire, session lookup, retry, stream/collect, release, error formatting.
 */
/** Check if a CodexApiError indicates the model is not supported on the account's plan. */
function isModelNotSupportedError(err: CodexApiError): boolean {
  // Only 4xx client errors (exclude 429 rate-limit)
  if (err.status < 400 || err.status >= 500 || err.status === 429) return false;
  const lower = err.message.toLowerCase();
  // Must contain "model" to avoid false positives like "feature not supported"
  if (!lower.includes("model")) return false;
  return lower.includes("not supported") || lower.includes("not_supported")
    || lower.includes("not available") || lower.includes("not_available");
}

export async function handleProxyRequest(
  c: Context,
  accountPool: AccountPool,
  cookieJar: CookieJar | undefined,
  req: ProxyRequest,
  fmt: FormatAdapter,
  proxyPool?: ProxyPool,
): Promise<Response> {
  // 1. Acquire account (model-aware)
  const acquired = accountPool.acquire({ model: req.codexRequest.model });
  if (!acquired) {
    c.status(fmt.noAccountStatus);
    return c.json(fmt.formatNoAccount());
  }

  const { entryId, token, accountId } = acquired;
  const proxyUrl = proxyPool?.resolveProxyUrl(entryId);
  let codexApi = new CodexApi(token, accountId, cookieJar, entryId, proxyUrl);
  // Tracks which account the outer catch should release (updated by retry loop)
  let activeEntryId = entryId;
  // Track tried accounts for model retry exclusion
  const triedEntryIds: string[] = [entryId];
  let modelRetried = false;

  console.log(
    `[${fmt.tag}] Account ${entryId} | Codex request:`,
    JSON.stringify(req.codexRequest).slice(0, 300),
  );

  let usageInfo: { input_tokens: number; output_tokens: number; cached_tokens?: number; reasoning_tokens?: number } | undefined;

  // P0-2: AbortController to kill curl when client disconnects
  const abortController = new AbortController();
  c.req.raw.signal.addEventListener("abort", () => abortController.abort(), { once: true });

  for (;;) { // model retry loop (max 1 retry)
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
          try {
            for await (const chunk of fmt.streamTranslator(
              codexApi,
              rawResponse,
              req.model,
              (u) => {
                usageInfo = u;
              },
              () => {},
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
            accountPool.release(activeEntryId, usageInfo);
          }
        });
      } else {
        // Non-streaming: retry loop for empty responses (switch accounts)
        const MAX_EMPTY_RETRIES = 2;
        let currentEntryId = activeEntryId;
        let currentCodexApi = codexApi;
        let currentRawResponse = rawResponse;

        for (let attempt = 1; ; attempt++) {
          try {
            const result = await fmt.collectTranslator(
              currentCodexApi,
              currentRawResponse,
              req.model,
            );
            accountPool.release(currentEntryId, result.usage);
            return c.json(result.response);
          } catch (collectErr) {
            if (collectErr instanceof EmptyResponseError && attempt <= MAX_EMPTY_RETRIES) {
              const emptyEmail = accountPool.getEntry(currentEntryId)?.email ?? "?";
              console.warn(
                `[${fmt.tag}] Account ${currentEntryId} (${emptyEmail}) | Empty response (attempt ${attempt}/${MAX_EMPTY_RETRIES + 1}), switching account...`,
              );
              accountPool.recordEmptyResponse(currentEntryId);
              accountPool.release(currentEntryId, collectErr.usage);

              // Acquire a new account (model-aware)
              const newAcquired = accountPool.acquire({ model: req.codexRequest.model });
              if (!newAcquired) {
                console.warn(`[${fmt.tag}] No available account for retry`);
                c.status(502);
                return c.json(fmt.formatError(502, "Codex returned an empty response and no other accounts are available for retry"));
              }

              currentEntryId = newAcquired.entryId;
              activeEntryId = currentEntryId;
              const retryProxyUrl = proxyPool?.resolveProxyUrl(newAcquired.entryId);
              currentCodexApi = new CodexApi(newAcquired.token, newAcquired.accountId, cookieJar, newAcquired.entryId, retryProxyUrl);
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
              const exhaustedEmail = accountPool.getEntry(currentEntryId)?.email ?? "?";
              console.warn(
                `[${fmt.tag}] Account ${currentEntryId} (${exhaustedEmail}) | Empty response (attempt ${attempt}/${MAX_EMPTY_RETRIES + 1}), all retries exhausted`,
              );
              accountPool.recordEmptyResponse(currentEntryId);
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
        // Model not supported on this account's plan → try a different account
        if (!modelRetried && isModelNotSupportedError(err)) {
          modelRetried = true;
          const failedEmail = accountPool.getEntry(activeEntryId)?.email ?? "?";
          console.warn(
            `[${fmt.tag}] Account ${activeEntryId} (${failedEmail}) | Model "${req.codexRequest.model}" not supported, trying different account...`,
          );
          accountPool.release(activeEntryId);

          const retry = accountPool.acquire({
            model: req.codexRequest.model,
            excludeIds: triedEntryIds,
          });
          if (retry) {
            activeEntryId = retry.entryId;
            triedEntryIds.push(retry.entryId);
            const retryProxyUrl = proxyPool?.resolveProxyUrl(retry.entryId);
            codexApi = new CodexApi(retry.token, retry.accountId, cookieJar, retry.entryId, retryProxyUrl);
            console.log(`[${fmt.tag}] Retrying with account ${retry.entryId}`);
            continue; // re-enter model retry loop
          }
          // No other account available — return error (already released above)
          const code = (err.status >= 400 && err.status < 600 ? err.status : 502) as StatusCode;
          c.status(code);
          return c.json(fmt.formatError(code, err.message));
        }

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

    break; // normal exit from model retry loop
  }

  // Should never reach here, but TypeScript needs a return
  c.status(500);
  return c.json(fmt.formatError(500, "Unexpected proxy handler exit"));
}
