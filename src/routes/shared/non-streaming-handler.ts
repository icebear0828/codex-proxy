import type { Context } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import { CodexApiError } from "../../proxy/codex-api.js";
import type { CodexApi, WsPoolContext } from "../../proxy/codex-api.js";
import type { AccountPool } from "../../auth/account-pool.js";
import type { CookieJar } from "../../proxy/cookie-jar.js";
import type { ProxyPool } from "../../proxy/proxy-pool.js";
import { EmptyResponseError, UpstreamPrematureCloseError } from "../../translation/codex-event-extractor.js";
import { releaseAccount } from "./account-acquisition.js";
import { toErrorStatus } from "./proxy-error-handler.js";
import type { SessionAffinityMap } from "../../auth/session-affinity.js";
import type { FormatAdapter, ProxyRequest, UsageHint } from "./proxy-handler-types.js";
import { annotateImageGenOutcome, stripCodexErrorPrefix } from "./proxy-handler-utils.js";
import { retryNonStreamingEmptyResponse } from "./non-streaming-empty-response-retry.js";
import { handleNonStreamingPrematureClose } from "./non-streaming-premature-close.js";
import { logNonStreamingUsage } from "./non-streaming-usage-log.js";

const MAX_EMPTY_RETRIES = 2;

export interface HandleNonStreamingOptions {
  c: Context;
  accountPool: AccountPool;
  cookieJar?: CookieJar;
  req: ProxyRequest;
  fmt: FormatAdapter;
  proxyPool?: ProxyPool;
  initialApi: CodexApi;
  initialResponse: Response;
  initialEntryId: string;
  abortController: AbortController;
  released: Set<string>;
  requestId: string;
  affinityMap?: SessionAffinityMap;
  conversationId?: string | null;
  turnState?: string;
  getUsageHint?: () => UsageHint | undefined;
  restoreImplicitResumeRequest?: () => void;
  buildPoolCtx?: (forEntryId: string) => WsPoolContext | undefined;
  setActiveAccount?: (entryId: string, api: CodexApi) => void;
  variantHash?: string;
}

export async function handleNonStreaming(options: HandleNonStreamingOptions): Promise<Response> {
  const {
    c,
    accountPool,
    cookieJar,
    req,
    fmt,
    proxyPool,
    initialApi,
    initialResponse,
    initialEntryId,
    abortController,
    released,
    requestId,
    affinityMap,
    conversationId,
    turnState,
    getUsageHint,
    restoreImplicitResumeRequest,
    buildPoolCtx,
    setActiveAccount,
    variantHash,
  } = options;
  let currentEntryId = initialEntryId;
  let currentApi = initialApi;
  let currentRawResponse = initialResponse;

  for (let attempt = 1; ; attempt++) {
    try {
      const responseFunctionCallIds = new Set<string>();
      const result = await fmt.collectTranslator({
        api: currentApi,
        response: currentRawResponse,
        model: req.model,
        tupleSchema: req.tupleSchema,
        usageHint: getUsageHint?.(),
        onResponseMetadata: (metadata) => {
          for (const callId of metadata.functionCallIds ?? []) {
            responseFunctionCallIds.add(callId);
          }
        },
      });
      if (result.responseId && affinityMap && conversationId) {
        affinityMap.record(
          result.responseId,
          currentEntryId,
          conversationId,
          turnState,
          req.codexRequest.instructions ?? undefined,
          result.usage.input_tokens,
          Array.from(responseFunctionCallIds),
          variantHash,
        );
      }
      if (result.usage) {
        logNonStreamingUsage({ tag: fmt.tag, entryId: currentEntryId, requestId, usage: result.usage });
      }
      releaseAccount(accountPool, currentEntryId, annotateImageGenOutcome(result.usage, req.expectsImageGen), released);
      return c.json(result.response);
    } catch (collectErr) {
      // Upstream FIN'd mid-reasoning (typically gpt-5.5 xhigh > 120 s cap).
      // Cross-account retry would re-hit the same cap and burn the pool, so
      // we fail fast with 504. The proxy can't recover this — the client
      // needs to lower reasoning effort or pick a different model.
      if (collectErr instanceof UpstreamPrematureCloseError) {
        const responsePlan = handleNonStreamingPrematureClose({
          accountPool,
          entryId: currentEntryId,
          err: collectErr,
          req,
          tag: fmt.tag,
          requestId,
          released,
          variantHash,
        });
        c.status(responsePlan.status);
        return c.json(fmt.formatError(responsePlan.status, responsePlan.message));
      }

      if (collectErr instanceof EmptyResponseError && attempt <= MAX_EMPTY_RETRIES) {
        const retry = await retryNonStreamingEmptyResponse({
          accountPool,
          currentEntryId,
          collectErr,
          req,
          tag: fmt.tag,
          attempt,
          maxRetries: MAX_EMPTY_RETRIES,
          cookieJar,
          proxyPool,
          abortSignal: abortController.signal,
          released,
          requestId,
          restoreImplicitResumeRequest,
          buildPoolCtx,
          setActiveAccount,
        });
        if (retry.action === "respond") {
          c.status(retry.status as StatusCode);
          return c.json(fmt.formatError(retry.status, retry.message));
        }
        currentEntryId = retry.entryId;
        currentApi = retry.api;
        currentRawResponse = retry.rawResponse;
        continue;
      }

      // Mid-SSE upstream errors (e.g. "No tool output found for function call",
      // "previous_response_not_found") need the same strip+retry recovery as
      // HTTP-time errors. Rethrow so the outer handleProxyRequest catch runs
      // its unified classification once. Critically, do NOT release the slot
      // here — outer catch's strip+retry continues on the same entryId and
      // would race another acquirer if we released early. Outer catch is
      // responsible for the release on the final respond/retry decision (the
      // released Set guards against double-release on terminal paths).
      if (collectErr instanceof CodexApiError) {
        console.warn(
          `[${fmt.tag}] Account ${currentEntryId} | upstream ${collectErr.status} during collect: ${stripCodexErrorPrefix(collectErr.message).slice(0, 200)}`,
        );
        throw collectErr;
      }
      releaseAccount(accountPool, currentEntryId, annotateImageGenOutcome(undefined, req.expectsImageGen), released);
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
