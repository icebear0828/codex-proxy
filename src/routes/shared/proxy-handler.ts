/**
 * Shared proxy handler — orchestrates the account acquire → retry →
 * stream/collect → release lifecycle common to all API format routes.
 *
 * Delegates to:
 *   - account-acquisition.ts  — acquire / release with idempotent guard
 *   - proxy-egress-log.ts     — upstream request audit log entries
 *   - proxy-error-handler.ts  — CodexApiError classification + pool state mutations
 *   - proxy-error-retry-transition.ts — CodexApiError retry/release/fallback transition
 *   - proxy-fallback-account-retry.ts — fallback account acquire / API rebuild
 *   - proxy-implicit-resume-lifecycle.ts — implicit-resume state machine / rollback
 *   - proxy-implicit-resume-request.ts — implicit-resume request apply/restore state
 *   - proxy-request-preparation.ts — request input/default forwarding fields
 *   - proxy-session-context.ts — prompt cache / affinity / implicit-resume derived state
 *   - proxy-retry-recovery.ts — same-account retry recovery decision/application
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
} from "./proxy-handler-types.js";
import { getSessionAffinityMap } from "../../auth/session-affinity.js";
import { randomUUID } from "crypto";
import {
  respondWithNoAccount,
  respondWithProxyError,
} from "./proxy-error-response.js";
import { applyProxyErrorRetryTransition } from "./proxy-error-retry-transition.js";
import { createImplicitResumeLifecycle } from "./proxy-implicit-resume-lifecycle.js";
import { captureImplicitResumeRequestState } from "./proxy-implicit-resume-request.js";
import {
  applyProxyRequestForwardingDefaults,
  ensureProxyRequestInputArray,
} from "./proxy-request-preparation.js";
import { buildRequestDiagnostics } from "./proxy-request-diagnostics.js";
import {
  applyProxyRetryRecoveryDecision,
  buildProxyRetryRecoveryDecision,
} from "./proxy-retry-recovery.js";
import { buildProxySessionContext } from "./proxy-session-context.js";
import { staggerIfNeeded } from "./proxy-stagger.js";
import { sendProxyUpstreamAttempt } from "./proxy-upstream-attempt.js";
import { buildWsPoolContext } from "./proxy-ws-context.js";

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
  // Idempotent-release guard: prevents double-release across retry branches
  const released = new Set<string>();

  const implicitResume = createImplicitResumeLifecycle({
    request: req,
    snapshot: originalRequestState,
    affinityMap,
    tag: fmt.tag,
    implicitPrevRespId: sessionContext.implicitPrevRespId,
    continuationInputStart: sessionContext.continuationInputStart,
    resumeEvaluationInput: sessionContext.resumeEvaluationInput,
    acquiredEntryId: entryId,
  });
  implicitResume.logSkippedWarnings();
  implicitResume.activate();

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
      resumeActive: implicitResume.evaluation.active,
      resumeReason: implicitResume.evaluation.reason,
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
        implicitResumeActive: implicitResume.isActive(),
        resumeReason: implicitResume.resumeReasonForAttempt(),
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
          usageHint: implicitResume.getUsageHint(),
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
        getUsageHint: () => implicitResume.getUsageHint(),
        restoreImplicitResumeRequest: implicitResume.restore,
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

      if (implicitResume.replayFullInputAfterError(err)) {
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
        applyProxyRetryRecoveryDecision({
          decision: retryRecovery,
          request: req,
          affinityMap,
          restoreImplicitResumeRequest: implicitResume.restore,
        });
        continue;
      }

      const decision = handleCodexApiError(
        err, accountPool, entryId, req.codexRequest.model, fmt.tag, modelRetried,
      );

      const errorRetryTransition = applyProxyErrorRetryTransition({
        accountPool,
        entryId,
        model: req.codexRequest.model,
        triedEntryIds,
        tag: fmt.tag,
        decision,
        released,
        restoreImplicitResumeRequest: implicitResume.restore,
        modelRetried,
        expectsImageGen: req.expectsImageGen,
        cookieJar,
        proxyPool,
      });
      if (errorRetryTransition.action === "respond") {
        return respondWithProxyError({
          c,
          req,
          fmt,
          status: errorRetryTransition.status,
          message: errorRetryTransition.message,
          ...(errorRetryTransition.useFormat429 ? { useFormat429: true } : {}),
        });
      }

      modelRetried = errorRetryTransition.modelRetried;
      entryId = errorRetryTransition.entryId;
      triedEntryIds.push(errorRetryTransition.entryId);
      codexApi = errorRetryTransition.api;
      await staggerIfNeeded(errorRetryTransition.prevSlotMs);
      continue;
    }
  }
}
