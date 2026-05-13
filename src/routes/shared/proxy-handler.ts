/**
 * Shared proxy handler — orchestrates the account acquire → retry →
 * stream/collect → release lifecycle common to all API format routes.
 *
 * Delegates to:
 *   - account-acquisition.ts  — acquire / release with idempotent guard
 *   - proxy-egress-log.ts     — upstream request audit log entries
 *   - proxy-error-handler.ts  — CodexApiError classification + pool state mutations
 *   - proxy-fallback-retry-plan.ts — account fallback retry response planning
 *   - proxy-debug-dump.ts     — opt-in request payload diagnostics
 *   - proxy-request-diagnostics.ts — request summary / large payload logs
 *   - proxy-stagger.ts        — request interval staggering
 *   - proxy-ws-context.ts     — WebSocket pool context construction
 *   - streaming-handler.ts    — streaming (SSE) response lifecycle
 *   - non-streaming-handler.ts — collect / retry response lifecycle
 */

import { CodexApiError } from "../../proxy/codex-api.js";
import { withRetry } from "../../utils/retry.js";
import { acquireAccount, releaseAccount } from "./account-acquisition.js";
import { handleCodexApiError } from "./proxy-error-handler.js";
import { handleStreaming } from "./streaming-handler.js";
import { handleNonStreaming } from "./non-streaming-handler.js";
import { annotateImageGenOutcome, buildCodexApi } from "./proxy-handler-utils.js";
import { dumpProxyRequest } from "./proxy-debug-dump.js";
import type {
  FormatAdapter,
  HandleProxyRequestOptions,
  ProxyRequest,
  UsageHint,
} from "./proxy-handler-types.js";
import { getSessionAffinityMap } from "../../auth/session-affinity.js";
import { randomUUID } from "crypto";
import { computeVariantHash } from "./variant-hash.js";
import {
  respondWithNoAccount,
  respondWithProxyError,
} from "./proxy-error-response.js";
import { buildProxyFallbackRetryPlan } from "./proxy-fallback-retry-plan.js";
import { recordProxyEgressLog } from "./proxy-egress-log.js";
import { applyParsedRateLimits, applyRateLimitHeaders, type ApplyParsedRateLimitsOptions } from "./proxy-rate-limit.js";
import { buildRequestDiagnostics } from "./proxy-request-diagnostics.js";
import { buildProxyRetryRecoveryDecision } from "./proxy-retry-recovery.js";
import { staggerIfNeeded } from "./proxy-stagger.js";
import { buildWsPoolContext } from "./proxy-ws-context.js";
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
    const diagnostics = buildRequestDiagnostics({
      tag: fmt.tag,
      entryId,
      requestId,
      request: req,
      chainConversationId,
      promptCacheKey,
      variantHash,
      explicitPrevRespId,
      implicitPrevRespId,
      prevRespId,
      resumeActive: resumeEval.active,
      resumeReason: resumeEval.reason,
      preferredEntryId,
    });
    console.log(diagnostics.summary);
    if (diagnostics.largePayloadWarning) console.warn(diagnostics.largePayloadWarning);
  }

  const abortController = new AbortController();
  c.req.raw.signal.addEventListener("abort", () => abortController.abort(), { once: true });

  await staggerIfNeeded(acquired.prevSlotMs);

  const buildPoolCtx = (forEntryId: string = entryId) =>
    buildWsPoolContext({
      useWebSocket: req.codexRequest.useWebSocket,
      conversationId: chainConversationId,
      entryId: forEntryId,
      variantHash,
      requestId,
      tag: fmt.tag,
    });

  for (;;) {
    try {
      const applyRateLimits = (rateLimits: ApplyParsedRateLimitsOptions["rateLimits"]): void => {
        applyParsedRateLimits({ accountPool, entryId, rateLimits });
      };

      const startMs = Date.now();
      dumpProxyRequest({
        requestId,
        tag: fmt.tag,
        entryId,
        conversationId: chainConversationId,
        implicitResumeActive,
        resumeReason: resumeEval.active ? null : resumeEval.reason,
        payload: req.codexRequest,
      });
      const rawResponse = await withRetry(
        () => codexApi.createResponse(req.codexRequest, abortController.signal, applyRateLimits, buildPoolCtx()),
        { tag: fmt.tag },
      );
      const status: number | null = rawResponse.status;
      recordProxyEgressLog({
        requestId,
        request: req,
        status,
        startMs,
      });

      // Capture upstream turn-state for sticky routing
      const upstreamTurnState = rawResponse.headers.get("x-codex-turn-state") ?? undefined;

      // Extract rate-limit quota from upstream response headers (passive collection — HTTP path)
      applyRateLimitHeaders({ accountPool, entryId, headers: rawResponse.headers });

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

      const retryRecovery = buildProxyRetryRecoveryDecision({
        err,
        tag: fmt.tag,
        entryId,
        stripAndRetryDone,
        previousResponseId: req.codexRequest.previous_response_id,
      });
      if (retryRecovery.action === "retry") {
        stripAndRetryDone = true;
        console.warn(retryRecovery.logMessage);
        if (retryRecovery.staleId) affinityMap.forget(retryRecovery.staleId);
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

      const fallbackAvailability = accountPool.hasAvailableAccounts(triedEntryIds)
        ? { available: true } as const
        : { available: false, summary: accountPool.getPoolSummary() } as const;
      const fallbackPlan = buildProxyFallbackRetryPlan({
        decision,
        availability: fallbackAvailability,
      });
      if (fallbackPlan.action === "respond") {
        return respondWithProxyError({
          c,
          req,
          fmt,
          status: fallbackPlan.status,
          message: fallbackPlan.message,
          ...(fallbackPlan.useFormat429 ? { useFormat429: true } : {}),
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
