import type { Context } from "hono";
import { stream } from "hono/streaming";
import type { AccountPool } from "../../auth/account-pool.js";
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
  } = options;

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");

  const capturedEntryId = entryId;
  const capturedApi = api;
  let usageInfo: UsageInfo | undefined;
  let capturedResponseId: string | null = null;
  const metadataCollector = createResponseMetadataCollector();

  return stream(c, async (s) => {
    s.onAbort(() => {
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
      affinityMap.record(
        capturedResponseId,
        capturedEntryId,
        conversationId,
        turnState,
        req.codexRequest.instructions ?? undefined,
        usageInfo?.input_tokens,
        Array.from(metadataCollector.responseFunctionCallIds),
        variantHash,
      );
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
        usageHint,
        onResponseMetadata: (metadata) => {
          metadataCollector.onResponseMetadata(metadata);
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
    } finally {
      abortController.abort();
      recordStreamAffinity();
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
