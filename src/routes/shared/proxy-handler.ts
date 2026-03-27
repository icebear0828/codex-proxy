/**
 * Shared proxy handler — orchestrates the account acquire → retry →
 * stream/collect → release lifecycle common to all API format routes.
 *
 * Delegates to:
 *   - account-acquisition.ts  — acquire / release with idempotent guard
 *   - proxy-error-handler.ts  — CodexApiError classification + pool state mutations
 *   - response-processor.ts   — streaming (SSE) response path
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
import { acquireAccount, releaseAccount } from "./account-acquisition.js";
import { handleCodexApiError, toErrorStatus } from "./proxy-error-handler.js";
import { streamResponse } from "./response-processor.js";
import type { UsageInfo } from "../../translation/codex-event-extractor.js";
import { parseRateLimitHeaders, rateLimitToQuota } from "../../proxy/rate-limit-headers.js";
import { getConfig } from "../../config.js";
import { jitterInt } from "../../utils/jitter.js";

/** Data prepared by each route after parsing and translating the request. */
export interface ProxyRequest {
  codexRequest: CodexResponsesRequest;
  model: string;
  isStreaming: boolean;
  /** Original schema before tuple→object conversion (for response reconversion). */
  tupleSchema?: Record<string, unknown> | null;
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
    tupleSchema?: Record<string, unknown> | null,
  ) => AsyncGenerator<string>;
  collectTranslator: (
    api: CodexApi,
    response: Response,
    model: string,
    tupleSchema?: Record<string, unknown> | null,
  ) => Promise<{
    response: unknown;
    usage: { input_tokens: number; output_tokens: number; cached_tokens?: number; reasoning_tokens?: number };
    responseId: string | null;
  }>;
}

const MAX_EMPTY_RETRIES = 2;

/** Sleep if this account had a recent request, to stagger upstream traffic. */
async function staggerIfNeeded(prevSlotMs: number | null): Promise<void> {
  const intervalMs = getConfig().auth.request_interval_ms;
  if (!intervalMs || prevSlotMs == null) return;
  const elapsed = Date.now() - prevSlotMs;
  const target = jitterInt(intervalMs, 0.3);
  const wait = target - elapsed;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

function buildCodexApi(
  token: string,
  accountId: string | null,
  cookieJar: CookieJar | undefined,
  entryId: string,
  proxyPool?: ProxyPool,
): CodexApi {
  const proxyUrl = proxyPool?.resolveProxyUrl(entryId);
  return new CodexApi(token, accountId, cookieJar, entryId, proxyUrl);
}

export async function handleProxyRequest(
  c: Context,
  accountPool: AccountPool,
  cookieJar: CookieJar | undefined,
  req: ProxyRequest,
  fmt: FormatAdapter,
  proxyPool?: ProxyPool,
): Promise<Response> {
  const acquired = acquireAccount(accountPool, req.codexRequest.model, undefined, fmt.tag);
  if (!acquired) {
    c.status(fmt.noAccountStatus);
    return c.json(fmt.formatNoAccount());
  }

  let { entryId } = acquired;
  let codexApi = buildCodexApi(acquired.token, acquired.accountId, cookieJar, entryId, proxyPool);
  const triedEntryIds: string[] = [entryId];
  let modelRetried = false;
  let usageInfo: UsageInfo | undefined;
  // Idempotent-release guard: prevents double-release across retry branches
  const released = new Set<string>();

  console.log(
    `[${fmt.tag}] Account ${entryId} | Codex request:`,
    JSON.stringify(req.codexRequest).slice(0, 300),
  );

  const abortController = new AbortController();
  c.req.raw.signal.addEventListener("abort", () => abortController.abort(), { once: true });

  await staggerIfNeeded(acquired.prevSlotMs);

  for (;;) {
    try {
      const rawResponse = await withRetry(
        () => codexApi.createResponse(req.codexRequest, abortController.signal),
        { tag: fmt.tag },
      );

      // Extract rate-limit quota from upstream response headers (passive collection)
      const rl = parseRateLimitHeaders(rawResponse.headers);
      if (rl) {
        const entry = accountPool.getEntry(entryId);
        const quota = rateLimitToQuota(rl, entry?.planType ?? null);
        accountPool.updateCachedQuota(entryId, quota);
        if (rl.primary?.reset_at != null) {
          const windowSec = rl.primary.window_minutes != null ? rl.primary.window_minutes * 60 : null;
          accountPool.syncRateLimitWindow(entryId, rl.primary.reset_at, windowSec);
        }
      }

      // ── Streaming path ──
      if (req.isStreaming) {
        c.header("Content-Type", "text/event-stream");
        c.header("Cache-Control", "no-cache");
        c.header("Connection", "keep-alive");

        const capturedEntryId = entryId;
        const capturedApi = codexApi;

        return stream(c, async (s) => {
          s.onAbort(() => abortController.abort());
          try {
            await streamResponse(
              s, capturedApi, rawResponse, req.model, fmt,
              (u) => { usageInfo = u; },
              req.tupleSchema,
            );
          } finally {
            abortController.abort();
            releaseAccount(accountPool, capturedEntryId, usageInfo, released);
          }
        });
      }

      // ── Non-streaming path (with empty-response retry) ──
      return await handleNonStreaming(
        c, accountPool, cookieJar, req, fmt, proxyPool,
        codexApi, rawResponse, entryId, abortController, released,
      );
    } catch (err) {
      if (!(err instanceof CodexApiError)) {
        releaseAccount(accountPool, entryId, undefined, released);
        throw err;
      }

      const decision = handleCodexApiError(
        err, accountPool, entryId, req.codexRequest.model, fmt.tag, modelRetried,
      );

      if (decision.action === "respond") {
        releaseAccount(accountPool, entryId, undefined, released);
        c.status(decision.status as StatusCode);
        return c.json(fmt.formatError(decision.status, decision.message));
      }

      if (decision.releaseBeforeRetry) {
        releaseAccount(accountPool, entryId, undefined, released);
      }
      if (decision.markModelRetried) {
        modelRetried = true;
      }

      const retry = acquireAccount(accountPool, req.codexRequest.model, triedEntryIds, fmt.tag);
      if (!retry) {
        const status = decision.status as StatusCode;
        c.status(status);
        if (decision.useFormat429) {
          return c.json(fmt.format429(decision.message));
        }
        return c.json(fmt.formatError(status, decision.message));
      }

      entryId = retry.entryId;
      triedEntryIds.push(retry.entryId);
      codexApi = buildCodexApi(retry.token, retry.accountId, cookieJar, retry.entryId, proxyPool);
      console.log(`[${fmt.tag}] Fallback → account ${retry.entryId}`);
      await staggerIfNeeded(retry.prevSlotMs);
      continue;
    }
  }
}

async function handleNonStreaming(
  c: Context,
  accountPool: AccountPool,
  cookieJar: CookieJar | undefined,
  req: ProxyRequest,
  fmt: FormatAdapter,
  proxyPool: ProxyPool | undefined,
  initialApi: CodexApi,
  initialResponse: Response,
  initialEntryId: string,
  abortController: AbortController,
  released: Set<string>,
): Promise<Response> {
  let currentEntryId = initialEntryId;
  let currentApi = initialApi;
  let currentRawResponse = initialResponse;

  for (let attempt = 1; ; attempt++) {
    try {
      const result = await fmt.collectTranslator(
        currentApi, currentRawResponse, req.model, req.tupleSchema,
      );
      releaseAccount(accountPool, currentEntryId, result.usage, released);
      return c.json(result.response);
    } catch (collectErr) {
      if (collectErr instanceof EmptyResponseError && attempt <= MAX_EMPTY_RETRIES) {
        const email = accountPool.getEntry(currentEntryId)?.email ?? "?";
        console.warn(
          `[${fmt.tag}] Account ${currentEntryId} (${email}) | Empty response (attempt ${attempt}/${MAX_EMPTY_RETRIES + 1}), switching account...`,
        );
        accountPool.recordEmptyResponse(currentEntryId);
        releaseAccount(accountPool, currentEntryId, collectErr.usage, released);

        const newAcquired = acquireAccount(accountPool, req.codexRequest.model, undefined, fmt.tag);
        if (!newAcquired) {
          c.status(502);
          return c.json(fmt.formatError(502, "Codex returned an empty response and no other accounts are available for retry"));
        }

        currentEntryId = newAcquired.entryId;
        currentApi = buildCodexApi(newAcquired.token, newAcquired.accountId, cookieJar, newAcquired.entryId, proxyPool);
        try {
          currentRawResponse = await withRetry(
            () => currentApi.createResponse(req.codexRequest, abortController.signal),
            { tag: fmt.tag },
          );
        } catch (retryErr) {
          releaseAccount(accountPool, currentEntryId, undefined, released);
          if (retryErr instanceof CodexApiError) {
            const code = toErrorStatus(retryErr.status);
            c.status(code);
            return c.json(fmt.formatError(code, retryErr.message));
          }
          throw retryErr;
        }
        continue;
      }

      releaseAccount(accountPool, currentEntryId, undefined, released);
      if (collectErr instanceof EmptyResponseError) {
        const email = accountPool.getEntry(currentEntryId)?.email ?? "?";
        console.warn(
          `[${fmt.tag}] Account ${currentEntryId} (${email}) | Empty response (attempt ${attempt}/${MAX_EMPTY_RETRIES + 1}), all retries exhausted`,
        );
        accountPool.recordEmptyResponse(currentEntryId);
        c.status(502);
        return c.json(fmt.formatError(502, "Codex returned empty responses across all available accounts"));
      }
      const msg = collectErr instanceof Error ? collectErr.message : "Unknown error";
      const statusMatch = msg.match(/HTTP\/[\d.]+ (\d{3})/);
      const upstreamStatus = statusMatch ? parseInt(statusMatch[1], 10) : 0;
      const code = toErrorStatus(upstreamStatus);
      c.status(code);
      return c.json(fmt.formatError(code, msg));
    }
  }
}
