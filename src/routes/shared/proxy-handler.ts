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
import {
  CodexApi,
  CodexApiError,
  PreviousResponseWebSocketError,
} from "../../proxy/codex-api.js";
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
import { deriveStableConversationKey } from "./stable-conversation-key.js";

/** Data prepared by each route after parsing and translating the request. */
export interface ProxyRequest {
  codexRequest: CodexResponsesRequest;
  model: string;
  isStreaming: boolean;
  /** Stable client-side conversation/session identifier when the upstream client provides one. */
  clientConversationId?: string;
  /** Original schema before tuple→object conversion (for response reconversion). */
  tupleSchema?: Record<string, unknown> | null;
  /** Whether this is a new conversation (no previous_response_id) — used for cache reporting. */
  isNewConversation?: boolean;
}

export interface UsageHint {
  reusedInputTokensUpperBound?: number;
}

export interface ResponseMetadata {
  functionCallIds?: string[];
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
    usageHint?: UsageHint,
    onResponseMetadata?: (metadata: ResponseMetadata) => void,
  ) => AsyncGenerator<string>;
  collectTranslator: (
    api: UpstreamAdapter,
    response: Response,
    model: string,
    tupleSchema?: Record<string, unknown> | null,
    usageHint?: UsageHint,
    onResponseMetadata?: (metadata: ResponseMetadata) => void,
  ) => Promise<{
    response: unknown;
    usage: { input_tokens: number; output_tokens: number; cached_tokens?: number; reasoning_tokens?: number };
    responseId: string | null;
  }>;
}

const MAX_EMPTY_RETRIES = 2;

function normalizeInstructions(instructions: string | null | undefined): string {
  return instructions ?? "";
}

export function shouldActivateImplicitResume(opts: {
  implicitPrevRespId: string | null;
  continuationInputStart: number;
  inputLength: number;
  preferredEntryId: string | null;
  acquiredEntryId: string;
  currentInstructions: string | null | undefined;
  storedInstructions: string | null;
  requiredFunctionCallOutputIds?: string[];
  storedFunctionCallIds?: string[];
}): boolean {
  const storedFunctionCallIds = new Set(opts.storedFunctionCallIds ?? []);
  const requiredFunctionCallOutputIds = opts.requiredFunctionCallOutputIds ?? [];
  const hasAllRequiredToolCalls = requiredFunctionCallOutputIds.every((callId) =>
    storedFunctionCallIds.has(callId),
  );

  return Boolean(
    opts.implicitPrevRespId &&
    opts.continuationInputStart < opts.inputLength &&
    opts.preferredEntryId &&
    opts.acquiredEntryId === opts.preferredEntryId &&
    normalizeInstructions(opts.currentInstructions) === normalizeInstructions(opts.storedInstructions) &&
    hasAllRequiredToolCalls,
  );
}

export function shouldReplayFullInputAfterImplicitResumeError(
  err: unknown,
  implicitResumeActive: boolean,
): err is PreviousResponseWebSocketError {
  return implicitResumeActive && err instanceof PreviousResponseWebSocketError;
}

function getContinuationInputStartIndex(input: CodexResponsesRequest["input"]): number {
  let lastModelOutputIndex = -1;
  for (let i = 0; i < input.length; i++) {
    const item = input[i];
    if ("role" in item) {
      if (item.role === "assistant") lastModelOutputIndex = i;
      continue;
    }
    if (item.type === "function_call") {
      lastModelOutputIndex = i;
    }
  }
  return lastModelOutputIndex >= 0 ? lastModelOutputIndex + 1 : 0;
}

function getFunctionCallOutputIds(input: CodexResponsesRequest["input"]): string[] {
  return input
    .filter((item): item is { type: "function_call_output"; call_id: string; output: string } =>
      !("role" in item) && item.type === "function_call_output")
    .map((item) => item.call_id);
}

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
  const affinityMap = getSessionAffinityMap();
  if (!Array.isArray(req.codexRequest.input)) {
    req.codexRequest.input = [];
  }
  const originalInput = req.codexRequest.input;
  const originalPreviousResponseId = req.codexRequest.previous_response_id;
  const originalTurnState = req.codexRequest.turnState;
  const originalUseWebSocket = req.codexRequest.useWebSocket;
  const currentInstructions = req.codexRequest.instructions;
  const explicitPrevRespId = req.codexRequest.previous_response_id;
  const derivedConversationId = deriveStableConversationKey(req.codexRequest);
  const promptCacheKey = derivedConversationId ?? req.clientConversationId ?? crypto.randomUUID();
  const continuationInputStart = explicitPrevRespId ? 0 : getContinuationInputStartIndex(req.codexRequest.input);
  const explicitConversationId = explicitPrevRespId ? affinityMap.lookupConversationId(explicitPrevRespId) : null;
  const chainConversationId = explicitConversationId ?? req.clientConversationId ?? promptCacheKey;
  const implicitPrevRespId =
    !explicitPrevRespId &&
    continuationInputStart > 0 &&
    req.clientConversationId
      ? affinityMap.lookupLatestResponseIdByConversationId(req.clientConversationId)
      : null;
  const prevRespId = explicitPrevRespId ?? implicitPrevRespId;
  const implicitStoredInstructions = implicitPrevRespId
    ? affinityMap.lookupInstructions(implicitPrevRespId)
    : null;
  const implicitContinuationInput = req.codexRequest.input.slice(continuationInputStart);
  const requiredFunctionCallOutputIds = implicitPrevRespId
    ? getFunctionCallOutputIds(implicitContinuationInput)
    : [];
  const implicitStoredFunctionCallIds = implicitPrevRespId
    ? affinityMap.lookupFunctionCallIds(implicitPrevRespId)
    : [];
  const missingFunctionCallOutputIds = requiredFunctionCallOutputIds.filter(
    (callId) => !implicitStoredFunctionCallIds.includes(callId),
  );

  // Session affinity: prefer the account that created the previous response
  const preferredEntryId =
    explicitPrevRespId
      ? affinityMap.lookup(explicitPrevRespId)
      : implicitPrevRespId && normalizeInstructions(currentInstructions) === normalizeInstructions(implicitStoredInstructions)
        ? affinityMap.lookup(implicitPrevRespId)
        : null;

  // Conversation ID: inherit from previous response chain, or derive from
  // content hash (enables cache hits across turns even without previous_response_id),
  // or fall back to a random UUID.
  req.codexRequest.prompt_cache_key = promptCacheKey;

  // Turn state: sticky routing token from upstream, echoed back on subsequent requests
  const explicitTurnState = explicitPrevRespId ? affinityMap.lookupTurnState(explicitPrevRespId) : null;
  if (explicitTurnState) req.codexRequest.turnState = explicitTurnState;

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
  const responseFunctionCallIds = new Set<string>();
  let activeUsageHint: UsageHint | undefined;
  let implicitResumeActive = false;
  // Idempotent-release guard: prevents double-release across retry branches
  const released = new Set<string>();

  if (implicitPrevRespId && missingFunctionCallOutputIds.length > 0) {
    console.warn(
      `[${fmt.tag}] 隐式续链跳过：上一轮 response 未记录 tool_result 对应的 call_id=` +
      missingFunctionCallOutputIds.slice(0, 3).join(","),
    );
  }

  if (shouldActivateImplicitResume({
    implicitPrevRespId,
    continuationInputStart,
    inputLength: req.codexRequest.input.length,
    preferredEntryId,
    acquiredEntryId: entryId,
    currentInstructions,
    storedInstructions: implicitStoredInstructions,
    requiredFunctionCallOutputIds,
    storedFunctionCallIds: implicitStoredFunctionCallIds,
  })) {
    req.codexRequest.previous_response_id = implicitPrevRespId!;
    req.codexRequest.useWebSocket = true;
    req.codexRequest.input = req.codexRequest.input.slice(continuationInputStart);
    const implicitTurnState = affinityMap.lookupTurnState(implicitPrevRespId!);
    if (implicitTurnState) req.codexRequest.turnState = implicitTurnState;
    activeUsageHint = {
      reusedInputTokensUpperBound: affinityMap.lookupInputTokens(implicitPrevRespId!) ?? undefined,
    };
    implicitResumeActive = true;
  }

  const restoreImplicitResumeRequest = (): void => {
    if (!implicitResumeActive) return;
    req.codexRequest.previous_response_id = originalPreviousResponseId;
    req.codexRequest.turnState = originalTurnState;
    req.codexRequest.useWebSocket = originalUseWebSocket;
    req.codexRequest.input = originalInput;
    req.codexRequest.instructions = currentInstructions;
    activeUsageHint = undefined;
    implicitResumeActive = false;
  };

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
          const recordStreamAffinity = (): void => {
            if (!capturedResponseId) return;
            affinityMap.record(
              capturedResponseId,
              capturedEntryId,
              chainConversationId,
              upstreamTurnState,
              req.codexRequest.instructions ?? undefined,
              usageInfo?.input_tokens,
              Array.from(responseFunctionCallIds),
            );
          };
          try {
            await streamResponse(
              s, capturedApi, rawResponse, req.model, fmt,
              (u) => {
                usageInfo = u;
                recordStreamAffinity();
              },
              req.tupleSchema,
              (id) => {
                capturedResponseId = id;
                recordStreamAffinity();
              },
              activeUsageHint,
              (metadata) => {
                for (const callId of metadata.functionCallIds ?? []) {
                  responseFunctionCallIds.add(callId);
                }
                recordStreamAffinity();
              },
            );
          } finally {
            abortController.abort();
            recordStreamAffinity();
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
        codexApi,
        rawResponse,
        entryId,
        abortController,
        released,
        affinityMap,
        chainConversationId,
        upstreamTurnState,
        () => activeUsageHint,
        restoreImplicitResumeRequest,
      );
    } catch (err) {
      if (!(err instanceof CodexApiError)) {
        releaseAccount(accountPool, entryId, undefined, released);
        throw err;
      }

      if (shouldReplayFullInputAfterImplicitResumeError(err, implicitResumeActive)) {
        console.warn(
          `[${fmt.tag}] 隐式续链 WebSocket 失败，回退为完整历史重放：${err.causeMessage}`,
        );
        restoreImplicitResumeRequest();
        continue;
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
      restoreImplicitResumeRequest();
      if (decision.markModelRetried) {
        modelRetried = true;
      }

      // Early exit: skip acquire overhead when no active accounts remain.
      // Lock already cleared by handleCodexApiError (markRateLimited/markStatus
      // → clearLock), so no releaseAccount call needed — matches existing !retry path.
      if (!accountPool.hasAvailableAccounts(triedEntryIds)) {
        const summary = accountPool.getPoolSummary();
        const parts: string[] = [];
        if (summary.rate_limited) parts.push(`${summary.rate_limited} rate-limited`);
        if (summary.expired) parts.push(`${summary.expired} expired`);
        if (summary.banned) parts.push(`${summary.banned} banned`);
        if (summary.disabled) parts.push(`${summary.disabled} disabled`);
        if (summary.quota_exhausted) parts.push(`${summary.quota_exhausted} quota-exhausted`);
        if (summary.refreshing) parts.push(`${summary.refreshing} refreshing`);
        const detail = parts.length
          ? `All accounts exhausted (${parts.join(", ")}). ${decision.message}`
          : `No accounts available. ${decision.message}`;
        const status = decision.status as StatusCode;
        c.status(status);
        if (decision.useFormat429) {
          return c.json(fmt.format429(detail));
        }
        return c.json(fmt.formatError(status, detail));
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
  getUsageHint?: () => UsageHint | undefined,
  restoreImplicitResumeRequest?: () => void,
): Promise<Response> {
  let currentEntryId = initialEntryId;
  let currentApi = initialApi;
  let currentRawResponse = initialResponse;

  for (let attempt = 1; ; attempt++) {
    try {
      const responseFunctionCallIds = new Set<string>();
      const result = await fmt.collectTranslator(
        currentApi,
        currentRawResponse,
        req.model,
        req.tupleSchema,
        getUsageHint?.(),
        (metadata) => {
          for (const callId of metadata.functionCallIds ?? []) {
            responseFunctionCallIds.add(callId);
          }
        },
      );
      if (result.responseId && affinityMap && conversationId) {
        affinityMap.record(
          result.responseId,
          currentEntryId,
          conversationId,
          turnState,
          req.codexRequest.instructions ?? undefined,
          result.usage.input_tokens,
          Array.from(responseFunctionCallIds),
        );
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
        restoreImplicitResumeRequest?.();

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
    if (err instanceof CodexApiError) {
      const code = toErrorStatus(err.status) as StatusCode;
      c.status(code);
      // For API-key upstreams, forward the raw upstream error body transparently
      try {
        const parsed: unknown = JSON.parse(err.body);
        if (parsed && typeof parsed === "object") {
          return c.json(parsed);
        }
      } catch { /* non-JSON body — fall through */ }
      if (code === 429) {
        return c.json(fmt.format429(err.message));
      }
      return c.json(fmt.formatError(code, err.message));
    }
    const msg = err instanceof Error ? err.message : "Upstream request failed";
    c.status(502);
    return c.json(fmt.formatError(502, msg));
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
