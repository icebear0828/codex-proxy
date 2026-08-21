import type { Context } from "hono";
import { stream } from "hono/streaming";
import type { AccountPool } from "../../auth/account-pool.js";
import { clearCfChallengeCooldown } from "../../auth/cf-challenge-cooldown.js";
import type { ChainAdvanceTicket, SessionAffinityMap } from "../../auth/session-affinity.js";
import type { CodexApi } from "../../proxy/codex-api.js";
import { recordStreamCloseEvent } from "../../logs/stream-close-event.js";
import { updateLogEntry } from "../../logs/entry.js";
import { calculateLogMetrics } from "../../logs/metrics.js";
import type { UsageInfo } from "../../translation/codex-event-extractor.js";
import { releaseAccount } from "./account-acquisition.js";
import type { FormatAdapter, ProxyRequest, UsageHint } from "./proxy-handler-types.js";
import { annotateImageGenOutcome, annotateUsageCost, recordClientKeyUsage } from "./proxy-handler-utils.js";
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
  chainAdvanceTicket: ChainAdvanceTicket;
  /** Whether this attempt was sent with an implicit-resume
   *  `previous_response_id`. Needed to break the dead-chain retry loop:
   *  if the upstream stream ends without response.completed while resume was
   *  active — silent close OR terminal error/response.failed frame — the
   *  cached prev id chain is poisoned and must be dropped so the client's
   *  retry performs a full-input replay instead of resending the same dead
   *  delta. */
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
    chainAdvanceTicket,
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
        chainAdvanceTicket,
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
    const streamStartMs = Date.now();
    let firstTokenMs: number | null = null;
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
        onFirstToken: (ts) => {
          firstTokenMs = ts;
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
      if (implicitResumeActive && !responseCompleted && !clientAborted) {
        // A resumed stream that ends without response.completed — whether via
        // silent close, an upstream terminal error/response.failed frame, or a
        // transport exception — leaves the prev id chain poisoned: the
        // client's retry would resend the same delta against the same dead
        // prev id and loop. The pooled WS may also keep rehashing to the same
        // bad backend. Drop both so the retry does a full-input replay over a
        // fresh connection instead.
        const cause = metadataCollector.terminalFailure
          ? "terminal failure frame"
          : metadataCollector.prematureClose
            ? "premature close"
            : "stream ended without response.completed";
        const dropped = affinityMap.forgetConversation(conversationId, variantHash);
        getWsPool().evictByEntryId(capturedEntryId);
        console.warn(
          `[implicit-resume-poison] rid=${requestId.slice(0, 8)} tag=${fmt.tag} model=${req.model}` +
            ` ${cause} on resumed stream — dropped ${dropped} affinity entries` +
            ` conv=${conversationId.slice(0, 8)} vh=${variantHash.slice(0, 12)}` +
            ` and evicted pooled WS for entry=${capturedEntryId.slice(0, 8)};` +
            ` next retry will replay full input on a fresh connection`,
        );
      }
      if (streamCompletedWithoutError) clearCfChallengeCooldown(capturedEntryId);
      if (usageInfo) {
        recordClientKeyUsage(c, req.model, usageInfo);
        logProxyUsage({
          tag: fmt.tag,
          entryId: capturedEntryId,
          requestId,
          usage: usageInfo,
          includeImageTokens: true,
          includeReasoningInHighInputWarning: true,
        });
      }

      const metrics = calculateLogMetrics({
        startMs: streamStartMs,
        firstTokenMs,
        endMs: Date.now(),
        model: req.model,
        usage: usageInfo ?? null,
      });
      c.set("metrics", metrics);
      updateLogEntry(requestId, {
        status: streamCompletedWithoutError ? 200 : (clientAborted ? 499 : 500),
        latencyMs: metrics.durationMs,
        ttftMs: metrics.ttftMs,
        durationMs: metrics.durationMs,
        costUsd: metrics.costUsd,
        tokensPerSecond: metrics.tokensPerSecond,
        usage: usageInfo ?? null,
        metrics,
      });

      releaseAccount(accountPool, capturedEntryId, annotateUsageCost(req.model, annotateImageGenOutcome(usageInfo, req.expectsImageGen)), released);
    }
  });
}
