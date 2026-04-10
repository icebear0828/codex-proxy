/**
 * Shared proxy handler — orchestrates the account acquire → retry →
 * stream/collect → release lifecycle common to all API format routes.
 *
 * Delegates to:
 *   - account-acquisition.ts  — acquire / release with idempotent guard
 *   - proxy-error-handler.ts  — CodexApiError classification + pool state mutations
 *   - response-processor.ts   — streaming (SSE) response path
 */

import crypto from "crypto";
import type { Context } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import { stream } from "hono/streaming";
import { CodexApi, CodexApiError } from "../../proxy/codex-api.js";
import type { CodexResponsesRequest } from "../../proxy/codex-api.js";
import type { UpstreamAdapter } from "../../proxy/upstream-adapter.js";
import { EmptyResponseError } from "../../translation/codex-event-extractor.js";
import type { AccountPool } from "../../auth/account-pool.js";
import type { CookieJar } from "../../proxy/cookie-jar.js";
import type { ProxyPool } from "../../proxy/proxy-pool.js";
import { withRetry } from "../../utils/retry.js";
import { acquireAccount, releaseAccount } from "./account-acquisition.js";
import { handleCodexApiError, toErrorStatus } from "./proxy-error-handler.js";
import { streamResponse } from "./response-processor.js";
import type { UsageInfo } from "../../translation/codex-event-extractor.js";
import { parseRateLimitHeaders, rateLimitToQuota, type ParsedRateLimit } from "../../proxy/rate-limit-headers.js";
import { getConfig } from "../../config.js";
import { jitterInt } from "../../utils/jitter.js";
import { getSessionAffinityMap, type SessionAffinityMap } from "../../auth/session-affinity.js";

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
    api: UpstreamAdapter,
    response: Response,
    model: string,
    onUsage: (u: { input_tokens: number; output_tokens: number; cached_tokens?: number; reasoning_tokens?: number }) => void,
    onResponseId: (id: string) => void,
    tupleSchema?: Record<string, unknown> | null,
  ) => AsyncGenerator<string>;
  collectTranslator: (
    api: UpstreamAdapter,
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
export async function staggerIfNeeded(prevSlotMs: number | null): Promise<void> {
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
  // Session affinity: prefer the account that created the previous response
  const affinityMap = getSessionAffinityMap();
  const prevRespId = req.codexRequest.previous_response_id;
  const preferredEntryId = prevRespId ? affinityMap.lookup(prevRespId) : null;

  // Conversation ID: inherit from previous response chain, or generate new
  const conversationId = (prevRespId ? affinityMap.lookupConversationId(prevRespId) : null)
    ?? crypto.randomUUID();
  req.codexRequest.prompt_cache_key = conversationId;

  // Turn state: sticky routing token from upstream, echoed back on subsequent requests
  const prevTurnState = prevRespId ? affinityMap.lookupTurnState(prevRespId) : null;
  if (prevTurnState) req.codexRequest.turnState = prevTurnState;

  // Set include for reasoning-enabled requests (matches Codex CLI behavior)
  if (req.codexRequest.reasoning && !req.codexRequest.include?.length) {
    req.codexRequest.include = ["reasoning.encrypted_content"];
  }

  // Single acquire call — preferredEntryId is a hint, not a hard requirement
  const acquired = acquireAccount(accountPool, req.codexRequest.model, undefined, fmt.tag, preferredEntryId ?? undefined);
  if (!acquired) {
    c.status(fmt.noAccountStatus);
    return c.json(fmt.formatNoAccount());
  }

  let { entryId } = acquired;
  let codexApi = buildCodexApi(acquired.token, acquired.accountId, cookieJar, entryId, proxyPool);
  const triedEntryIds: string[] = [entryId];
  let modelRetried = false;
  let usageInfo: UsageInfo | undefined;
  let capturedResponseId: string | null = null;
  // Idempotent-release guard: prevents double-release across retry branches
  const released = new Set<string>();

  {
    const reqJson = JSON.stringify(req.codexRequest);
    const inputItems = req.codexRequest.input?.length ?? 0;
    const instrLen = req.codexRequest.instructions?.length ?? 0;
    const affinityHit = preferredEntryId && entryId === preferredEntryId;
    const reasoningField = req.codexRequest.reasoning
      ? `effort=${req.codexRequest.reasoning.effort ?? "none"} summary=${req.codexRequest.reasoning.summary ?? "none"}`
      : "off";
    console.log(
      `[${fmt.tag}] Account ${entryId} | model=${req.model} | input_items=${inputItems} instr=${instrLen}B payload=${reqJson.length}B reasoning=[${reasoningField}]` +
      (prevRespId ? ` | affinity=${affinityHit ? "hit" : "miss"}` : ""),
    );
    if (reqJson.length > 50_000) {
      // Log per-item size breakdown to diagnose large payload origin
      const itemSizes = (req.codexRequest.input ?? []).map((item, i) => {
        const sz = JSON.stringify(item).length;
        const role = typeof item === "object" && item !== null && "role" in item ? (item as Record<string, unknown>).role : (item as Record<string, unknown>).type;
        return `  [${i}] ${role} ${sz}B`;
      });
      console.warn(
        `[${fmt.tag}] ⚠ Large payload (${(reqJson.length / 1024).toFixed(1)}KB) — input_items=${inputItems} instr=${instrLen}B\n` +
        `  instructions: ${instrLen}B\n` +
        itemSizes.join("\n"),
      );
    }
  }

  const abortController = new AbortController();
  c.req.raw.signal.addEventListener("abort", () => abortController.abort(), { once: true });

  await staggerIfNeeded(acquired.prevSlotMs);

  for (;;) {
    try {
      // Apply parsed rate-limit data to the account pool (shared by header + WS event paths)
      const applyRateLimits = (rl: ParsedRateLimit): void => {
        const entry = accountPool.getEntry(entryId);
        const quota = rateLimitToQuota(rl, entry?.planType ?? null);
        accountPool.updateCachedQuota(entryId, quota);
        if (rl.primary?.reset_at != null) {
          const windowSec = rl.primary.window_minutes != null ? rl.primary.window_minutes * 60 : null;
          accountPool.syncRateLimitWindow(entryId, rl.primary.reset_at, windowSec);
        }
        // Proactively mark exhausted accounts so they don't get re-selected
        if (quota.rate_limit.limit_reached && rl.primary?.reset_at != null) {
          const backoffSec = rl.primary.reset_at - Math.floor(Date.now() / 1000);
          if (backoffSec > 0) {
            accountPool.markRateLimited(entryId, { retryAfterSec: backoffSec });
          }
        }
      };

      const rawResponse = await withRetry(
        () => codexApi.createResponse(req.codexRequest, abortController.signal, applyRateLimits),
        { tag: fmt.tag },
      );

      // Capture upstream turn-state for sticky routing
      const upstreamTurnState = rawResponse.headers.get("x-codex-turn-state") ?? undefined;

      // Extract rate-limit quota from upstream response headers (passive collection — HTTP path)
      const rl = parseRateLimitHeaders(rawResponse.headers);
      if (rl) applyRateLimits(rl);

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
              (id) => { capturedResponseId = id; },
            );
          } finally {
            abortController.abort();
            if (capturedResponseId) {
              affinityMap.record(capturedResponseId, capturedEntryId, conversationId, upstreamTurnState);
            }
            if (usageInfo) {
              const uncached = usageInfo.cached_tokens
                ? usageInfo.input_tokens - usageInfo.cached_tokens
                : usageInfo.input_tokens;
              console.log(
                `[${fmt.tag}] Account ${capturedEntryId} | Usage: in=${usageInfo.input_tokens}` +
                (usageInfo.cached_tokens ? ` (cached=${usageInfo.cached_tokens} uncached=${uncached})` : "") +
                ` out=${usageInfo.output_tokens}` +
                (usageInfo.reasoning_tokens ? ` reasoning=${usageInfo.reasoning_tokens}` : ""),
              );
              if (usageInfo.input_tokens > 10_000) {
                console.warn(
                  `[${fmt.tag}] ⚠ High input token count: ${usageInfo.input_tokens} tokens` +
                  (usageInfo.reasoning_tokens ? ` (reasoning=${usageInfo.reasoning_tokens})` : ""),
                );
              }
            }
            releaseAccount(accountPool, capturedEntryId, usageInfo, released);
          }
        });
      }

      // ── Non-streaming path (with empty-response retry) ──
      return await handleNonStreaming(
        c, accountPool, cookieJar, req, fmt, proxyPool,
        codexApi, rawResponse, entryId, abortController, released, affinityMap, conversationId, upstreamTurnState,
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
  affinityMap?: SessionAffinityMap,
  conversationId?: string,
  turnState?: string,
): Promise<Response> {
  let currentEntryId = initialEntryId;
  let currentApi = initialApi;
  let currentRawResponse = initialResponse;

  for (let attempt = 1; ; attempt++) {
    try {
      const result = await fmt.collectTranslator(
        currentApi, currentRawResponse, req.model, req.tupleSchema,
      );
      if (result.responseId && affinityMap && conversationId) {
        affinityMap.record(result.responseId, currentEntryId, conversationId, turnState);
      }
      if (result.usage) {
        const u = result.usage;
        const uncached = u.cached_tokens ? u.input_tokens - u.cached_tokens : u.input_tokens;
        console.log(
          `[${fmt.tag}] Account ${currentEntryId} | Usage: in=${u.input_tokens}` +
          (u.cached_tokens ? ` (cached=${u.cached_tokens} uncached=${uncached})` : "") +
          ` out=${u.output_tokens}` +
          (u.reasoning_tokens ? ` reasoning=${u.reasoning_tokens}` : ""),
        );
        if (u.input_tokens > 10_000) {
          console.warn(`[${fmt.tag}] ⚠ High input token count: ${u.input_tokens} tokens`);
        }
      }
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

/**
 * Lightweight handler for API-key-based upstreams (OpenAI, Anthropic, Gemini, custom).
 * No account pool management, no session affinity, no retry logic — just proxy + translate.
 */
export async function handleDirectRequest(
  c: Context,
  upstream: UpstreamAdapter,
  req: ProxyRequest,
  fmt: FormatAdapter,
): Promise<Response> {
  const abortController = new AbortController();
  c.req.raw.signal.addEventListener("abort", () => abortController.abort(), { once: true });

  let rawResponse: Response;
  try {
    rawResponse = await upstream.createResponse(req.codexRequest, abortController.signal);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Upstream request failed";
    const status = err instanceof CodexApiError ? err.status : 502;
    if (status === 429) {
      c.status(429);
      return c.json(fmt.format429(msg));
    }
    const code = toErrorStatus(status) as StatusCode;
    c.status(code);
    return c.json(fmt.formatError(code, msg));
  }

  if (req.isStreaming) {
    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");

    return stream(c, async (s) => {
      s.onAbort(() => abortController.abort());
      await streamResponse(s, upstream, rawResponse, req.model, fmt, () => {}, req.tupleSchema, () => {});
    });
  }

  // Non-streaming
  try {
    const result = await fmt.collectTranslator(upstream, rawResponse, req.model, req.tupleSchema);
    return c.json(result.response);
  } catch (err) {
    abortController.abort();
    const msg = err instanceof Error ? err.message : "Failed to collect upstream response";
    const code = toErrorStatus(0) as StatusCode;
    c.status(code);
    return c.json(fmt.formatError(code, msg));
  }
}
