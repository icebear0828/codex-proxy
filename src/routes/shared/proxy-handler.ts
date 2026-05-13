/**
 * Shared proxy handler — orchestrates the account acquire → retry →
 * stream/collect → release lifecycle common to all API format routes.
 *
 * Delegates to:
 *   - account-acquisition.ts  — acquire / release with idempotent guard
 *   - proxy-egress-log.ts     — upstream request audit log entries
 *   - proxy-error-handler.ts  — CodexApiError classification + pool state mutations
 *   - proxy-fallback-retry-plan.ts — account fallback retry response planning
 *   - proxy-implicit-resume-request.ts — implicit-resume request apply/restore state
 *   - proxy-request-preparation.ts — request input/default forwarding fields
 *   - proxy-session-context.ts — prompt cache / affinity / implicit-resume derived state
 *   - proxy-upstream-attempt.ts — one upstream request attempt + egress/rate-limit capture
 *   - proxy-debug-dump.ts     — opt-in request payload diagnostics
 *   - proxy-request-diagnostics.ts — request summary / large payload logs
 *   - proxy-stagger.ts        — request interval staggering
 *   - proxy-ws-context.ts     — WebSocket pool context construction
 *   - streaming-handler.ts    — streaming (SSE) response lifecycle
 *   - non-streaming-handler.ts — collect / retry response lifecycle
 */

import { CodexApiError } from "../../proxy/codex-api.js";
import { acquireAccount, releaseAccount } from "./account-acquisition.js";
import { handleCodexApiError } from "./proxy-error-handler.js";
import { handleStreaming } from "./streaming-handler.js";
import { handleNonStreaming } from "./non-streaming-handler.js";
import { annotateImageGenOutcome, buildCodexApi } from "./proxy-handler-utils.js";
import type {
  FormatAdapter,
  HandleProxyRequestOptions,
  ProxyRequest,
  UsageHint,
} from "./proxy-handler-types.js";
import { getSessionAffinityMap } from "../../auth/session-affinity.js";
import { randomUUID } from "crypto";
import {
  respondWithNoAccount,
  respondWithProxyError,
} from "./proxy-error-response.js";
import { buildProxyFallbackRetryPlan } from "./proxy-fallback-retry-plan.js";
import {
  applyImplicitResumeRequest,
  captureImplicitResumeRequestState,
  restoreImplicitResumeRequestState,
} from "./proxy-implicit-resume-request.js";
import {
  applyProxyRequestForwardingDefaults,
  ensureProxyRequestInputArray,
} from "./proxy-request-preparation.js";
import { buildRequestDiagnostics } from "./proxy-request-diagnostics.js";
import { buildProxyRetryRecoveryDecision } from "./proxy-retry-recovery.js";
import { buildProxySessionContext } from "./proxy-session-context.js";
import { staggerIfNeeded } from "./proxy-stagger.js";
import { sendProxyUpstreamAttempt } from "./proxy-upstream-attempt.js";
import { buildWsPoolContext } from "./proxy-ws-context.js";
import {
  evaluateImplicitResume,
  shouldReplayFullInputAfterImplicitResumeError,
} from "./proxy-session-helpers.js";

export async function handleProxyRequest(options: HandleProxyRequestOptions): Promise<Response> {
  const { c, accountPool, cookieJar, req, fmt, proxyPool } = options;
  c.set("logForwarded", true);

  const affinityMap = getSessionAffinityMap();
  const requestId = c.get("requestId") ?? randomUUID().slice(0, 8);
  ensureProxyRequestInputArray(req);
  const originalRequestState = captureImplicitResumeRequestState(req);
  const sessionContext = buildProxySessionContext({ request: req, affinityMap });

  // Turn state: sticky routing token from upstream, echoed back on subsequent requests
  applyProxyRequestForwardingDefaults({
    request: req,
    promptCacheKey: sessionContext.promptCacheKey,
    explicitTurnState: sessionContext.explicitTurnState,
  });

  // Single acquire call — preferredEntryId is a hint, not a hard requirement
  const acquired = acquireAccount(accountPool, req.codexRequest.model, undefined, fmt.tag, sessionContext.preferredEntryId ?? undefined);
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
    ...sessionContext.resumeEvaluationInput,
    acquiredEntryId: entryId,
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
    activeUsageHint = applyImplicitResumeRequest({
      request: req,
      implicitPrevRespId: sessionContext.implicitPrevRespId!,
      continuationInputStart: sessionContext.continuationInputStart,
      affinityMap,
    });
    implicitResumeActive = true;
  }

  const restoreImplicitResumeRequest = (): void => {
    if (!implicitResumeActive) return;
    restoreImplicitResumeRequestState({ request: req, snapshot: originalRequestState });
    activeUsageHint = undefined;
    implicitResumeActive = false;
  };

  {
    const diagnostics = buildRequestDiagnostics({
      tag: fmt.tag,
      entryId,
      requestId,
      request: req,
      chainConversationId: sessionContext.chainConversationId,
      promptCacheKey: sessionContext.promptCacheKey,
      variantHash: sessionContext.variantHash,
      explicitPrevRespId: sessionContext.explicitPrevRespId,
      implicitPrevRespId: sessionContext.implicitPrevRespId,
      prevRespId: sessionContext.prevRespId,
      resumeActive: resumeEval.active,
      resumeReason: resumeEval.reason,
      preferredEntryId: sessionContext.preferredEntryId,
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
      conversationId: sessionContext.chainConversationId,
      entryId: forEntryId,
      variantHash: sessionContext.variantHash,
      requestId,
      tag: fmt.tag,
    });

  for (;;) {
    try {
      const { rawResponse, upstreamTurnState } = await sendProxyUpstreamAttempt({
        accountPool,
        api: codexApi,
        request: req,
        entryId,
        abortSignal: abortController.signal,
        buildPoolCtx,
        requestId,
        tag: fmt.tag,
        conversationId: sessionContext.chainConversationId,
        implicitResumeActive,
        resumeReason: resumeEval.active ? null : resumeEval.reason,
      });

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
          conversationId: sessionContext.chainConversationId,
          turnState: upstreamTurnState,
          usageHint: activeUsageHint,
          variantHash: sessionContext.variantHash,
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
        conversationId: sessionContext.chainConversationId,
        turnState: upstreamTurnState,
        getUsageHint: () => activeUsageHint,
        restoreImplicitResumeRequest,
        buildPoolCtx,
        setActiveAccount: (nextEntryId, nextApi) => {
          entryId = nextEntryId;
          codexApi = nextApi;
          if (!triedEntryIds.includes(nextEntryId)) triedEntryIds.push(nextEntryId);
        },
        variantHash: sessionContext.variantHash,
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
