/**
 * Shared proxy handler — orchestrates the account acquire → retry →
 * stream/collect → release lifecycle common to all API format routes.
 *
 * Delegates to:
 *   - account-acquisition.ts  — acquire / release with idempotent guard
 *   - proxy-error-handler.ts  — CodexApiError classification + pool state mutations
 *   - streaming-handler.ts    — streaming (SSE) response lifecycle
 *   - non-streaming-handler.ts — collect / retry response lifecycle
 */

import { CodexApiError } from "../../proxy/codex-api.js";
import { withRetry } from "../../utils/retry.js";
import { debugDump, debugDumpEnabled } from "../../utils/debug-dump.js";
import { acquireAccount, releaseAccount } from "./account-acquisition.js";
import { handleCodexApiError } from "./proxy-error-handler.js";
import { isPreviousResponseNotFoundError, isUnansweredFunctionCallError } from "../../proxy/error-classification.js";
import { handleStreaming } from "./streaming-handler.js";
import { handleNonStreaming } from "./non-streaming-handler.js";
import { annotateImageGenOutcome, buildCodexApi, stripCodexErrorPrefix } from "./proxy-handler-utils.js";
import type {
  FormatAdapter,
  HandleProxyRequestOptions,
  ProxyRequest,
  UsageHint,
} from "./proxy-handler-types.js";
import { parseRateLimitHeaders, rateLimitToQuota, type ParsedRateLimit } from "../../proxy/rate-limit-headers.js";
import { getConfig } from "../../config.js";
import { jitterInt } from "../../utils/jitter.js";
import { getSessionAffinityMap } from "../../auth/session-affinity.js";
import { enqueueLogEntry } from "../../logs/entry.js";
import { randomUUID } from "crypto";
import { computeVariantHash } from "./variant-hash.js";
import { getWsPool } from "../../proxy/ws-pool.js";
import type { WsPoolContext } from "../../proxy/codex-api.js";
import {
  buildAccountExhaustionDetail,
  respondWithNoAccount,
  respondWithProxyError,
} from "./proxy-error-response.js";
import {
  buildVariantIdentity,
  evaluateImplicitResume,
  getContinuationInputStartIndex,
  getFunctionCallOutputIds,
  IMPLICIT_RESUME_MAX_AGE_MS,
  normalizeInstructions,
  resolvePromptCacheIdentity,
  shouldReplayFullInputAfterImplicitResumeError,
} from "./proxy-session-helpers.js";

/** Sleep if this account had a recent request, to stagger upstream traffic. */
export async function staggerIfNeeded(prevSlotMs: number | null): Promise<void> {
  const intervalMs = getConfig().auth.request_interval_ms;
  if (!intervalMs || prevSlotMs == null) return;
  const elapsed = Date.now() - prevSlotMs;
  const target = jitterInt(intervalMs, 0.3);
  const wait = target - elapsed;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

export async function handleProxyRequest(options: HandleProxyRequestOptions): Promise<Response> {
  const { c, accountPool, cookieJar, req, fmt, proxyPool } = options;
  c.set("logForwarded", true);

  const affinityMap = getSessionAffinityMap();
  const requestId = c.get("requestId") ?? randomUUID().slice(0, 8);
  if (!Array.isArray(req.codexRequest.input)) {
    req.codexRequest.input = [];
  }
  const originalInput = req.codexRequest.input;
  const originalPreviousResponseId = req.codexRequest.previous_response_id;
  const originalTurnState = req.codexRequest.turnState;
  const originalUseWebSocket = req.codexRequest.useWebSocket;
  const currentInstructions = req.codexRequest.instructions;
  const explicitPrevRespId = req.codexRequest.previous_response_id;
  const promptCacheIdentity = resolvePromptCacheIdentity(req.codexRequest, req.clientConversationId);
  const promptCacheKey = promptCacheIdentity.promptCacheKey;
  const continuationInputStart = explicitPrevRespId ? 0 : getContinuationInputStartIndex(req.codexRequest.input);
  const explicitConversationId = explicitPrevRespId ? affinityMap.lookupConversationId(explicitPrevRespId) : null;
  // effectiveConversationId follows the same identity used by prompt_cache_key:
  // explicit key > client session > content hash > random fallback.
  const effectiveConversationId = promptCacheIdentity.conversationId;
  const chainConversationId = explicitConversationId ?? effectiveConversationId;
  // Variant fingerprint isolates concurrent shapes of the same conversation
  // (sub-agents, parallel tool calls) onto independent pool slots + prev_id
  // chains. See `variant-hash.ts`. Cheap (sha256 over bytes already in memory)
  // so we always compute it, even on routes that won't use it.
  const variantIdentity = buildVariantIdentity(req.codexRequest, promptCacheIdentity);
  const variantHash = computeVariantHash(
    req.codexRequest.instructions,
    req.codexRequest.tools,
    variantIdentity,
  );
  const implicitPrevRespId =
    !explicitPrevRespId &&
    continuationInputStart > 0 &&
    effectiveConversationId
      ? affinityMap.lookupLatestResponseIdByConversationId(
          effectiveConversationId,
          IMPLICIT_RESUME_MAX_AGE_MS,
          variantHash,
        )
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
  // Session affinity: prefer the account that created the previous response
  const preferredEntryId =
    explicitPrevRespId
      ? affinityMap.lookup(explicitPrevRespId)
      : implicitPrevRespId && normalizeInstructions(currentInstructions) === normalizeInstructions(implicitStoredInstructions)
        ? affinityMap.lookup(implicitPrevRespId)
        : null;

  // Conversation ID: honor explicit prompt_cache_key first, otherwise prefer
  // client session IDs (Claude Code), then content hash, then random fallback.
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
    return respondWithNoAccount({ c, req, fmt });
  }

  let { entryId } = acquired;
  let codexApi = buildCodexApi(acquired.token, acquired.accountId, cookieJar, entryId, proxyPool);
  const triedEntryIds: string[] = [entryId];
  let modelRetried = false;
  let stripAndRetryDone = false;
  let activeUsageHint: UsageHint | undefined;
  let implicitResumeActive = false;
  // Idempotent-release guard: prevents double-release across retry branches
  const released = new Set<string>();

  const resumeEval = evaluateImplicitResume({
    implicitPrevRespId,
    continuationInputStart,
    inputLength: req.codexRequest.input.length,
    preferredEntryId,
    acquiredEntryId: entryId,
    currentInstructions,
    storedInstructions: implicitStoredInstructions,
    requiredFunctionCallOutputIds,
    storedFunctionCallIds: implicitStoredFunctionCallIds,
  });
  if (!resumeEval.active && resumeEval.missingCallIds && resumeEval.missingCallIds.length > 0) {
    console.warn(
      `[${fmt.tag}] 隐式续链跳过：上一轮 response 未记录 tool_result 对应的 call_id=` +
      resumeEval.missingCallIds.slice(0, 3).join(","),
    );
  }
  if (!resumeEval.active && resumeEval.unansweredCallIds && resumeEval.unansweredCallIds.length > 0) {
    console.warn(
      `[${fmt.tag}] 隐式续链跳过：上一轮 function_call 未被全部回复，缺 call_id=` +
      resumeEval.unansweredCallIds.slice(0, 3).join(","),
    );
  }
  if (resumeEval.active) {
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
    const toolsCount = req.codexRequest.tools?.length ?? 0;
    const affinityHit = preferredEntryId && entryId === preferredEntryId;
    const reasoningField = req.codexRequest.reasoning
      ? `effort=${req.codexRequest.reasoning.effort ?? "none"} summary=${req.codexRequest.reasoning.summary ?? "none"}`
      : "off";
    const prevSrc = explicitPrevRespId
      ? "explicit"
      : implicitPrevRespId
        ? "implicit"
        : null;
    const prevField = prevSrc && prevRespId
      ? `${prevSrc}:${prevRespId.slice(-8)}`
      : "none";
    const convField = chainConversationId ? chainConversationId.slice(0, 8) : "none";
    const keyField = promptCacheKey.slice(0, 8);
    // explicit prev is always honoured; implicit prev's activation is gated by evaluateImplicitResume.
    const resumeField = explicitPrevRespId
      ? "explicit"
      : implicitPrevRespId
        ? (resumeEval.active ? "on" : `off:${resumeEval.reason}`)
        : null;
    console.log(
      `[${fmt.tag}] Account ${entryId} | model=${req.model} | rid=${requestId.slice(0, 8)} conv=${convField} key=${keyField} vh=${variantHash} prev=${prevField}` +
      (resumeField ? ` resume=${resumeField}` : "") +
      ` | input_items=${inputItems} tools=${toolsCount} instr=${instrLen}B payload=${reqJson.length}B reasoning=[${reasoningField}]` +
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

  /** Build a per-request WS pool context. Only attached when the request is
   *  going to take the WS path AND we have a stable conversation id — empty
   *  conversationId would degenerate the pool key and break affinity. */
  const buildPoolCtx = (forEntryId: string = entryId): WsPoolContext | undefined => {
    if (!req.codexRequest.useWebSocket) return undefined;
    if (!chainConversationId) return undefined;
    return {
      pool: getWsPool(),
      poolKey: `${forEntryId}:${chainConversationId}:${variantHash}`,
      entryId: forEntryId,
      onDecision: (decision) => {
        const ridShort = requestId.slice(0, 8);
        const tag = decision.kind === "bypass"
          ? `bypass(${decision.reason})`
          : decision.kind === "retry-after-stale-reuse"
            ? `retry-after-stale-reuse:${decision.wsId}`
            : `${decision.kind}:${decision.wsId}`;
        console.log(`[${fmt.tag}] Account ${forEntryId} | rid=${ridShort} | ws=${tag}`);
      },
    };
  };

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
        // Proactively mark exhausted accounts so they don't get re-selected.
        // updateCachedQuota above already records the truth; this call only
        // exists for its side effects (lifecycle.clearLock + WS pool eviction).
        if (quota.rate_limit.limit_reached && rl.primary?.reset_at != null) {
          const backoffSec = rl.primary.reset_at - Math.floor(Date.now() / 1000);
          if (backoffSec > 0) {
            accountPool.applyRateLimit429(entryId, { resetsAtSec: rl.primary.reset_at });
          }
        }
      };

      const startMs = Date.now();
      if (debugDumpEnabled()) {
        debugDump("request", {
          rid: requestId,
          tag: fmt.tag,
          entryId,
          conv: chainConversationId ?? null,
          implicitResumeActive,
          resumeReason: resumeEval.active ? null : resumeEval.reason,
          payload: req.codexRequest,
        });
      }
      const rawResponse = await withRetry(
        () => codexApi.createResponse(req.codexRequest, abortController.signal, applyRateLimits, buildPoolCtx()),
        { tag: fmt.tag },
      );
      const status: number | null = rawResponse.status;
      enqueueLogEntry({
        requestId,
        direction: "egress",
        method: "POST",
        path: "/codex/responses",
        model: req.model,
        provider: "codex",
        status,
        latencyMs: Date.now() - startMs,
        stream: req.isStreaming,
        request: {
          model: req.codexRequest.model,
          stream: req.codexRequest.stream,
          useWebSocket: req.codexRequest.useWebSocket,
        },
      });

      // Capture upstream turn-state for sticky routing
      const upstreamTurnState = rawResponse.headers.get("x-codex-turn-state") ?? undefined;

      // Extract rate-limit quota from upstream response headers (passive collection — HTTP path)
      const rl = parseRateLimitHeaders(rawResponse.headers);
      if (rl) applyRateLimits(rl);

      // ── Streaming path ──
      if (req.isStreaming) {
        return handleStreaming({
          c,
          accountPool,
          req,
          fmt,
          api: codexApi,
          response: rawResponse,
          entryId,
          abortController,
          released,
          requestId,
          affinityMap,
          conversationId: chainConversationId,
          turnState: upstreamTurnState,
          usageHint: activeUsageHint,
          variantHash,
        });
      }

      // ── Non-streaming path (with empty-response retry) ──
      return await handleNonStreaming({
        c,
        accountPool,
        cookieJar,
        req,
        fmt,
        proxyPool,
        initialApi: codexApi,
        initialResponse: rawResponse,
        initialEntryId: entryId,
        abortController,
        released,
        requestId,
        affinityMap,
        conversationId: chainConversationId,
        turnState: upstreamTurnState,
        getUsageHint: () => activeUsageHint,
        restoreImplicitResumeRequest,
        buildPoolCtx,
        setActiveAccount: (nextEntryId, nextApi) => {
          entryId = nextEntryId;
          codexApi = nextApi;
          if (!triedEntryIds.includes(nextEntryId)) triedEntryIds.push(nextEntryId);
        },
        variantHash,
      });
    } catch (err) {
      if (!(err instanceof CodexApiError)) {
        releaseAccount(accountPool, entryId, annotateImageGenOutcome(undefined, req.expectsImageGen), released);
        throw err;
      }

      if (shouldReplayFullInputAfterImplicitResumeError(err, implicitResumeActive)) {
        console.warn(
          `[${fmt.tag}] 隐式续链 WebSocket 失败，回退为完整历史重放：${err.causeMessage}`,
        );
        restoreImplicitResumeRequest();
        continue;
      }

      // previous_response_id stale (account doesn't recognise it / map lost on
      // restart / cross-account routing): drop the ID and retry once on the
      // same account. For implicit-resume requests this also restores the
      // full input history; for explicit ones the client's own input is sent
      // verbatim (server-side history is lost but the request still completes).
      if (!stripAndRetryDone && isPreviousResponseNotFoundError(err)) {
        stripAndRetryDone = true;
        const staleId = req.codexRequest.previous_response_id;
        console.warn(
          `[${fmt.tag}] Account ${entryId} | previous_response_not_found (id=${staleId ?? "?"}), stripping and retrying same account`,
        );
        if (staleId) affinityMap.forget(staleId);
        restoreImplicitResumeRequest();
        req.codexRequest.previous_response_id = undefined;
        req.codexRequest.turnState = undefined;
        continue;
      }

      // Upstream rejected because a stored function_call from the previous
      // response was not answered with a function_call_output. Recovery is the
      // same as previous_response_not_found: drop previous_response_id, replay
      // full history, retry once on the same account.
      if (!stripAndRetryDone && isUnansweredFunctionCallError(err)) {
        stripAndRetryDone = true;
        const staleId = req.codexRequest.previous_response_id;
        console.warn(
          `[${fmt.tag}] Account ${entryId} | unanswered_function_call (id=${staleId ?? "?"}): ${stripCodexErrorPrefix(err.message).slice(0, 200)}, stripping and retrying same account`,
        );
        if (staleId) affinityMap.forget(staleId);
        restoreImplicitResumeRequest();
        req.codexRequest.previous_response_id = undefined;
        req.codexRequest.turnState = undefined;
        continue;
      }

      const decision = handleCodexApiError(
        err, accountPool, entryId, req.codexRequest.model, fmt.tag, modelRetried,
      );

      if (decision.action === "respond") {
        releaseAccount(accountPool, entryId, annotateImageGenOutcome(undefined, req.expectsImageGen), released);
        return respondWithProxyError({
          c,
          req,
          fmt,
          status: decision.status,
          message: decision.message,
        });
      }

      if (decision.releaseBeforeRetry) {
        releaseAccount(accountPool, entryId, annotateImageGenOutcome(undefined, req.expectsImageGen), released);
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
        const detail = buildAccountExhaustionDetail(summary, decision.message);
        return respondWithProxyError({
          c,
          req,
          fmt,
          status: decision.status,
          message: detail,
          useFormat429: decision.useFormat429,
        });
      }

      const retry = acquireAccount(accountPool, req.codexRequest.model, triedEntryIds, fmt.tag);
      if (!retry) {
        return respondWithProxyError({
          c,
          req,
          fmt,
          status: decision.status,
          message: decision.message,
          useFormat429: decision.useFormat429,
        });
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
