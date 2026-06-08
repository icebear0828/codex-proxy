import type { Context } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import type { SessionAffinityMap } from "../../auth/session-affinity.js";
import type { AccountPool } from "../../auth/account-pool.js";
import type { CodexApi, WsPoolContext } from "../../proxy/codex-api.js";
import { CodexApiError } from "../../proxy/codex-api.js";
import type { CookieJar } from "../../proxy/cookie-jar.js";
import type { ProxyPool } from "../../proxy/proxy-pool.js";
import type { UpstreamPrematureCloseError, UsageInfo, EmptyResponseError } from "../../translation/codex-event-extractor.js";
import type {
  FormatAdapter,
  FormatCollectTranslatorResult,
  ProxyRequest,
  ResponseMetadata,
  UsageHint,
} from "./proxy-handler-types.js";
import { releaseAccount, acquireAccount } from "./account-acquisition.js";
import { toErrorStatus } from "./proxy-error-handler.js";
import { annotateImageGenOutcome, buildCodexApi, stripCodexErrorPrefix } from "./proxy-handler-utils.js";
import { createResponseMetadataCollector } from "./response-metadata-collector.js";
import { withRetry } from "../../utils/retry.js";
import { recordProxyEgressLog } from "./proxy-egress-log.js";
import { recordStreamCloseEvent } from "../../logs/stream-close-event.js";
import { logProxyUsage } from "./proxy-usage-log.js";
import type { ReasoningReplayItem } from "../../proxy/reasoning-replay-cache.js";

// ── 1. non-streaming-affinity ─────────────────────────────────────
export interface RecordNonStreamingSuccessAffinityOptions {
  affinityMap?: SessionAffinityMap;
  responseId: string | null;
  entryId: string;
  conversationId?: string | null;
  turnState?: string;
  instructions?: string | null;
  inputTokens: number;
  responseFunctionCallIds: Iterable<string>;
  variantHash?: string;
}

export function recordNonStreamingSuccessAffinity(
  options: RecordNonStreamingSuccessAffinityOptions,
): boolean {
  const {
    affinityMap,
    responseId,
    entryId,
    conversationId,
    turnState,
    instructions,
    inputTokens,
    responseFunctionCallIds,
    variantHash,
  } = options;

  if (!responseId || !affinityMap || !conversationId) return false;

  affinityMap.record(
    responseId,
    entryId,
    conversationId,
    turnState,
    instructions,
    inputTokens,
    Array.from(new Set(responseFunctionCallIds)),
    variantHash,
  );
  return true;
}

// ── 2. non-streaming-codex-api-error ──────────────────────────────
export interface RethrowNonStreamingCodexApiErrorDuringCollectOptions {
  err: CodexApiError;
  tag: string;
  entryId: string;
}

export function rethrowNonStreamingCodexApiErrorDuringCollect(
  options: RethrowNonStreamingCodexApiErrorDuringCollectOptions,
): never {
  const { err, tag, entryId } = options;

  console.warn(
    `[${tag}] Account ${entryId} | upstream ${err.status} during collect: ${stripCodexErrorPrefix(err.message).slice(0, 200)}`,
  );
  throw err;
}

// ── 3. non-streaming-collect-error-response ───────────────────────
export interface NonStreamingCollectErrorResponsePlan {
  status: StatusCode;
  message: string;
}

export function planNonStreamingCollectErrorResponse(
  collectErr: unknown,
): NonStreamingCollectErrorResponsePlan {
  const message = collectErr instanceof Error ? collectErr.message : "Unknown error";
  const statusMatch = message.match(/HTTP\/[\d.]+ (\d{3})/);
  const upstreamStatus = statusMatch ? parseInt(statusMatch[1], 10) : 0;
  return {
    status: toErrorStatus(upstreamStatus),
    message,
  };
}

// ── 4. non-streaming-collect-failure ──────────────────────────────
export interface HandleNonStreamingCollectFailureOptions {
  accountPool: AccountPool;
  entryId: string;
  req: ProxyRequest;
  collectErr: unknown;
  released: Set<string>;
}

export function handleNonStreamingCollectFailure(
  options: HandleNonStreamingCollectFailureOptions,
): NonStreamingCollectErrorResponsePlan {
  const {
    accountPool,
    entryId,
    req,
    collectErr,
    released,
  } = options;

  releaseAccount(accountPool, entryId, annotateImageGenOutcome(undefined, req.expectsImageGen), released);
  return planNonStreamingCollectErrorResponse(collectErr);
}

// ── 5. non-streaming-collect-response ─────────────────────────────
export interface CollectNonStreamingResponseOptions {
  fmt: FormatAdapter;
  api: CodexApi;
  rawResponse: Response;
  req: ProxyRequest;
  usageHint?: UsageHint;
  onResponseMetadata?: (metadata: ResponseMetadata) => void;
}

export interface CollectNonStreamingResponseResult {
  result: FormatCollectTranslatorResult;
  responseFunctionCallIds: Set<string>;
  reasoningReplayItems: ReasoningReplayItem[];
  invalidReasoningReplay: boolean;
}

export async function collectNonStreamingResponse(
  options: CollectNonStreamingResponseOptions,
): Promise<CollectNonStreamingResponseResult> {
  const {
    fmt,
    api,
    rawResponse,
    req,
    usageHint,
    onResponseMetadata,
  } = options;
  const metadataCollector = createResponseMetadataCollector();
  const result = await fmt.collectTranslator({
    api,
    response: rawResponse,
    model: req.model,
    tupleSchema: req.tupleSchema,
    usageHint,
    onResponseMetadata: (metadata) => {
      metadataCollector.onResponseMetadata(metadata);
      onResponseMetadata?.(metadata);
    },
  });

  return {
    result,
    responseFunctionCallIds: metadataCollector.responseFunctionCallIds,
    reasoningReplayItems: metadataCollector.reasoningReplayItems,
    invalidReasoningReplay: metadataCollector.invalidReasoningReplay,
  };
}

// ── 6. non-streaming-empty-response-exhausted ─────────────────────
export interface NonStreamingEmptyResponseExhaustedResponsePlan {
  status: 502;
  message: string;
}

export interface HandleNonStreamingEmptyResponseExhaustedOptions {
  accountPool: AccountPool;
  entryId: string;
  req: ProxyRequest;
  tag: string;
  attempt: number;
  maxRetries: number;
  released: Set<string>;
  logWarn?: (message: string) => void;
}

export function handleNonStreamingEmptyResponseExhausted(
  options: HandleNonStreamingEmptyResponseExhaustedOptions,
): NonStreamingEmptyResponseExhaustedResponsePlan {
  const {
    accountPool,
    entryId,
    req,
    tag,
    attempt,
    maxRetries,
    released,
    logWarn = (message) => console.warn(message),
  } = options;

  releaseAccount(accountPool, entryId, annotateImageGenOutcome(undefined, req.expectsImageGen), released);
  const email = accountPool.getEntry(entryId)?.email ?? "?";
  logWarn(
    `[${tag}] Account ${entryId} (${email}) | Empty response (attempt ${attempt}/${maxRetries + 1}), all retries exhausted`,
  );
  accountPool.recordEmptyResponse(entryId);

  return {
    status: 502,
    message: "Codex returned empty responses across all available accounts",
  };
}

// ── 7. non-streaming-empty-response-retry ─────────────────────────
export type NonStreamingEmptyResponseRetryResult =
  | {
      action: "respond";
      status: number;
      message: string;
    }
  | {
      action: "retry";
      entryId: string;
      api: CodexApi;
      rawResponse: Response;
    };

export interface RetryNonStreamingEmptyResponseOptions {
  accountPool: AccountPool;
  currentEntryId: string;
  collectErr: EmptyResponseError;
  req: ProxyRequest;
  tag: string;
  attempt: number;
  maxRetries: number;
  cookieJar?: CookieJar;
  proxyPool?: ProxyPool;
  abortSignal: AbortSignal;
  released: Set<string>;
  requestId: string;
  restoreImplicitResumeRequest?: () => void;
  buildPoolCtx?: (forEntryId: string) => WsPoolContext | undefined;
  setActiveAccount?: (entryId: string, api: CodexApi) => void;
  nowMs?: () => number;
  logWarn?: (message: string) => void;
}

export async function retryNonStreamingEmptyResponse(
  options: RetryNonStreamingEmptyResponseOptions,
): Promise<NonStreamingEmptyResponseRetryResult> {
  const {
    accountPool,
    currentEntryId,
    collectErr,
    req,
    tag,
    attempt,
    maxRetries,
    cookieJar,
    proxyPool,
    abortSignal,
    released,
    requestId,
    restoreImplicitResumeRequest,
    buildPoolCtx,
    setActiveAccount,
    nowMs = Date.now,
    logWarn = (message) => console.warn(message),
  } = options;

  const email = accountPool.getEntry(currentEntryId)?.email ?? "?";
  logWarn(
    `[${tag}] Account ${currentEntryId} (${email}) | Empty response (attempt ${attempt}/${maxRetries + 1}), switching account...`,
  );
  accountPool.recordEmptyResponse(currentEntryId);
  releaseAccount(accountPool, currentEntryId, annotateImageGenOutcome(collectErr.usage, req.expectsImageGen), released);
  restoreImplicitResumeRequest?.();

  const acquired = acquireAccount(accountPool, req.codexRequest.model, undefined, tag);
  if (!acquired) {
    return {
      action: "respond",
      status: 502,
      message: "Codex returned an empty response and no other accounts are available for retry",
    };
  }

  const nextApi = buildCodexApi(acquired.token, acquired.accountId, cookieJar, acquired.entryId, proxyPool);
  setActiveAccount?.(acquired.entryId, nextApi);

  const retryStartMs = nowMs();
  try {
    const rawResponse = await withRetry(
      () => nextApi.createResponse(req.codexRequest, abortSignal, undefined, buildPoolCtx?.(acquired.entryId)),
      { tag },
    );
    recordProxyEgressLog({
      requestId,
      request: req,
      status: rawResponse.status,
      startMs: retryStartMs,
    });
    return {
      action: "retry",
      entryId: acquired.entryId,
      api: nextApi,
      rawResponse,
    };
  } catch (retryErr) {
    releaseAccount(accountPool, acquired.entryId, annotateImageGenOutcome(undefined, req.expectsImageGen), released);
    const msg = retryErr instanceof Error ? retryErr.message : "Upstream request failed";
    recordProxyEgressLog({
      requestId,
      request: req,
      status: retryErr instanceof CodexApiError ? retryErr.status : null,
      error: msg,
      startMs: retryStartMs,
    });
    if (retryErr instanceof CodexApiError) {
      const code = toErrorStatus(retryErr.status);
      return {
        action: "respond",
        status: code,
        message: retryErr.message,
      };
    }
    throw retryErr;
  }
}

// ── 8. non-streaming-premature-close ──────────────────────────────
export interface NonStreamingPrematureCloseResponsePlan {
  status: 504;
  message: string;
}

export interface HandleNonStreamingPrematureCloseOptions {
  accountPool: AccountPool;
  entryId: string;
  err: UpstreamPrematureCloseError;
  req: ProxyRequest;
  tag: string;
  requestId: string;
  released: Set<string>;
  variantHash?: string;
  logWarn?: (message: string) => void;
}

export function handleNonStreamingPrematureClose(
  options: HandleNonStreamingPrematureCloseOptions,
): NonStreamingPrematureCloseResponsePlan {
  const {
    accountPool,
    entryId,
    err,
    req,
    tag,
    requestId,
    released,
    variantHash,
    logWarn = (message) => console.warn(message),
  } = options;

  const email = accountPool.getEntry(entryId)?.email ?? "?";
  logWarn(
    `[${tag}] Account ${entryId} (${email}) | upstream premature close (hadReasoning=${err.hadReasoning} events=${err.eventCount}) — failing fast, not retrying`,
  );
  recordStreamCloseEvent({
    kind: "upstream-premature",
    requestId,
    tag,
    model: req.model,
    accountEntryId: entryId,
    variantHash,
    responseId: err.responseId,
    eventCount: err.eventCount,
    hadReasoning: err.hadReasoning,
    detail: err.message,
  });
  releaseAccount(accountPool, entryId, annotateImageGenOutcome(undefined, req.expectsImageGen), released);

  return {
    status: 504,
    message: err.message,
  };
}

// ── 9. non-streaming-success-release ─────────────────────────────
export interface ReleaseNonStreamingSuccessAccountOptions {
  accountPool: AccountPool;
  entryId: string;
  usage: UsageInfo;
  expectsImageGen?: boolean;
  released: Set<string>;
}

export function releaseNonStreamingSuccessAccount(options: ReleaseNonStreamingSuccessAccountOptions): void {
  const {
    accountPool,
    entryId,
    usage,
    expectsImageGen,
    released,
  } = options;

  releaseAccount(accountPool, entryId, annotateImageGenOutcome(usage, expectsImageGen), released);
}

// ── 10. non-streaming-usage-log ──────────────────────────────────
export interface LogNonStreamingUsageOptions {
  tag: string;
  entryId: string;
  requestId: string;
  usage: UsageInfo;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

export function logNonStreamingUsage(options: LogNonStreamingUsageOptions): void {
  logProxyUsage(options);
}
