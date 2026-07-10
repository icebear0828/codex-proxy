import type { Context } from "hono";
import { stream } from "hono/streaming";
import type { AccountPool } from "../../auth/account-pool.js";
import { clearCfChallengeCooldown } from "../../auth/cf-challenge-cooldown.js";
import type { SessionAffinityMap } from "../../auth/session-affinity.js";
import type { CodexApi } from "../../proxy/codex-api.js";
import { recordStreamCloseEvent } from "../../logs/stream-close-event.js";
import type { UsageInfo } from "../../translation/codex-event-extractor.js";
import { releaseAccount } from "./account-acquisition.js";
import type { FormatAdapter, ProxyRequest, UsageHint } from "./proxy-handler-types.js";
import { annotateImageGenOutcome } from "./proxy-handler-utils.js";
import { streamResponse } from "./response-processor.js";
import { createResponseMetadataCollector } from "./response-metadata-collector.js";
import { logProxyUsage } from "./proxy-usage-log.js";
import { getReasoningReplayCache } from "../../proxy/reasoning-replay-cache.js";
import { getWsPool } from "../../proxy/ws-pool.js";

export interface HandleStreamingOptions {
  c: Context;
  accountPool: AccountPool;
  req: ProxyRequest;
  fmt: FormatAdapter;
  api: CodexApi;
  response: Response;
  entryId: string;
  abortController: AbortController;
  released: Set<string>;
  requestId: string;
  affinityMap: SessionAffinityMap;
  conversationId: string;
  turnState?: string;
  usageHint?: UsageHint;
  variantHash: string;
  /** Whether this attempt was sent with an implicit-resume
   *  `previous_response_id`. Needed to break the silent-death retry loop:
   *  if the upstream stream ends without a terminal event while resume was
   *  active, the cached prev id chain is poisoned and must be dropped so the
   *  client's retry performs a full-input replay instead of resending the
   *  same dead delta. */
  implicitResumeActive?: boolean;
}

export function handleStreaming(options: HandleStreamingOptions): Response {
  const {
    c,
    accountPool,
    req,
    fmt,
    api,
    response,
    entryId,
    abortController,
    released,
    requestId,
    affinityMap,
    conversationId,
    turnState,
    usageHint,
    variantHash,
    implicitResumeActive = false,
  } = options;

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");
  // Disable response buffering on nginx-class reverse proxies so SSE heartbeats
  // and deltas reach the client immediately instead of being held back.
  c.header("X-Accel-Buffering", "no");

  const capturedEntryId = entryId;
  const capturedApi = api;
  let usageInfo: UsageInfo | undefined;
  let capturedResponseId: string | null = null;
  let responseCompleted = false;
  let streamCompletedWithoutError = false;
  const metadataCollector = createResponseMetadataCollector();
  const reasoningReplayCache = getReasoningReplayCache();

  return stream(c, async (s) => {
    let clientAborted = false;
    let streamFailed = true;
    s.onAbort(() => {
      if (streamCompletedWithoutError || responseCompleted) {
        return;
      }
      clientAborted = true;
      console.warn(`[stream-client-abort] rid=${requestId.slice(0, 8)} tag=${fmt.tag} model=${req.model}`);
      recordStreamCloseEvent({
        kind: "client-abort",
        requestId,
        tag: fmt.tag,
        model: req.model,
        accountEntryId: capturedEntryId,
        variantHash,
        responseId: capturedResponseId ?? null,
      });
      abortController.abort();
    });
    const recordStreamAffinity = (): void => {
      if (!capturedResponseId) return;
      if (!responseCompleted) return;
      affinityMap.record(
        capturedResponseId,
        capturedEntryId,
        conversationId,
        turnState,
        req.codexRequest.instructions,
        usageInfo?.input_tokens,
        Array.from(metadataCollector.responseFunctionCallIds),
        variantHash,
      );
      if (!metadataCollector.invalidReasoningReplay && metadataCollector.reasoningReplayItems.length > 0) {
        reasoningReplayCache.record({
          responseId: capturedResponseId,
          entryId: capturedEntryId,
          conversationId,
          variantHash,
          items: metadataCollector.reasoningReplayItems,
        });
      }
    };
    const evictReasoningReplayIdentity = (): void => {
      reasoningReplayCache.evictByIdentity({
        entryId: capturedEntryId,
        conversationId,
        variantHash,
      });
    };
    try {
      await streamResponse({
        writer: s,
        api: capturedApi,
        response,
        model: req.model,
        adapter: fmt,
        onUsage: (u) => {
          usageInfo = u;
          recordStreamAffinity();
        },
        tupleSchema: req.tupleSchema,
        onResponseId: (id) => {
          capturedResponseId = id;
          recordStreamAffinity();
        },
        onResponseCompleted: (id) => {
          if (id) capturedResponseId = id;
          responseCompleted = true;
          recordStreamAffinity();
        },
        usageHint,
        onResponseMetadata: (metadata) => {
          metadataCollector.onResponseMetadata(metadata);
          if (metadataCollector.invalidReasoningReplay) {
            evictReasoningReplayIdentity();
          }
          recordStreamAffinity();
        },
        diagnostics: {
          requestId: requestId.slice(0, 8),
          tag: fmt.tag,
          provider: "codex",
          path: "/codex/responses",
          accountEntryId: capturedEntryId,
          variantHash,
          abortSignal: abortController.signal,
        },
      });
      streamFailed = false;
      streamCompletedWithoutError = true;
    } finally {
      if (streamFailed && !clientAborted && !abortController.signal.aborted) {
        abortController.abort();
      }
      recordStreamAffinity();
      if (
        implicitResumeActive &&
        metadataCollector.prematureClose &&
        !responseCompleted &&
        !clientAborted
      ) {
        // Silent upstream death on a resumed stream: the prev id chain for
        // this conversation is poisoned (the backend that owned it is gone or
        // refuses this model), and the pooled WS may keep rehashing to the
        // same bad backend. Drop both so the client's automatic retry does a
        // full-input replay over a fresh connection instead of looping.
        const dropped = affinityMap.forgetConversation(conversationId, variantHash);
        getWsPool().evictByEntryId(capturedEntryId);
        console.warn(
          `[implicit-resume-poison] rid=${requestId.slice(0, 8)} tag=${fmt.tag} model=${req.model}` +
            ` premature close on resumed stream — dropped ${dropped} affinity entries` +
            ` conv=${conversationId.slice(0, 8)} vh=${variantHash.slice(0, 12)}` +
            ` and evicted pooled WS for entry=${capturedEntryId.slice(0, 8)};` +
            ` next retry will replay full input on a fresh connection`,
        );
      }
      if (streamCompletedWithoutError) clearCfChallengeCooldown(capturedEntryId);
      if (usageInfo) {
        logProxyUsage({
          tag: fmt.tag,
          entryId: capturedEntryId,
          requestId,
          usage: usageInfo,
          includeImageTokens: true,
          includeReasoningInHighInputWarning: true,
        });
      }
      releaseAccount(accountPool, capturedEntryId, annotateImageGenOutcome(usageInfo, req.expectsImageGen), released);
    }
  });
}
