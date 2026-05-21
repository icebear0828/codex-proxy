import type { AccountPool } from "../../auth/account-pool.js";
import { CodexApiError } from "../../proxy/codex-api.js";
import type { CodexApi, WsPoolContext } from "../../proxy/codex-api.js";
import type { CookieJar } from "../../proxy/cookie-jar.js";
import type { ProxyPool } from "../../proxy/proxy-pool.js";
import { EmptyResponseError } from "../../translation/codex-event-extractor.js";
import { withRetry } from "../../utils/retry.js";
import { acquireAccount, releaseAccount } from "./account-acquisition.js";
import { toErrorStatus } from "./proxy-error-handler.js";
import { recordProxyEgressLog } from "./proxy-egress-log.js";
import type { ProxyRequest } from "./proxy-handler-types.js";
import { annotateImageGenOutcome, buildCodexApi } from "./proxy-handler-utils.js";

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
