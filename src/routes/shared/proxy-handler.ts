/**
 * Shared proxy handler — orchestrates the account acquire → retry →
 * stream/collect → release lifecycle common to all API format routes.
 *
 * Delegates to:
 *   - account-acquisition.ts  — acquire / release with idempotent guard
 *   - proxy-error-handler.ts  — CodexApiError classification + pool state mutations
 *   - response-processor.ts   — streaming (SSE) response path
 */

import crypto from "crypto";
import type { Context } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import { stream } from "hono/streaming";
import {
  CodexApi,
  CodexApiError,
  PreviousResponseWebSocketError,
} from "../../proxy/codex-api.js";
import type { CodexResponsesRequest } from "../../proxy/codex-api.js";
import type { UpstreamAdapter } from "../../proxy/upstream-adapter.js";
import { EmptyResponseError, UpstreamPrematureCloseError } from "../../translation/codex-event-extractor.js";
import type { AccountPool } from "../../auth/account-pool.js";
import type { CookieJar } from "../../proxy/cookie-jar.js";
import type { ProxyPool } from "../../proxy/proxy-pool.js";
import { withRetry } from "../../utils/retry.js";
import { debugDump, debugDumpEnabled } from "../../utils/debug-dump.js";
import { acquireAccount, releaseAccount } from "./account-acquisition.js";
import { handleCodexApiError, toErrorStatus } from "./proxy-error-handler.js";
import { isPreviousResponseNotFoundError, isUnansweredFunctionCallError } from "../../proxy/error-classification.js";
import { streamResponse } from "./response-processor.js";
import type { UsageInfo } from "../../translation/codex-event-extractor.js";
import { parseRateLimitHeaders, rateLimitToQuota, type ParsedRateLimit } from "../../proxy/rate-limit-headers.js";
import { getConfig } from "../../config.js";
import { jitterInt } from "../../utils/jitter.js";
import { getSessionAffinityMap, type SessionAffinityMap } from "../../auth/session-affinity.js";
import { enqueueLogEntry } from "../../logs/entry.js";
import { randomUUID } from "crypto";
import { deriveStableConversationKey } from "./stable-conversation-key.js";
import { computeVariantHash } from "./variant-hash.js";
import { getWsPool } from "../../proxy/ws-pool.js";
import type { WsPoolContext } from "../../proxy/codex-api.js";

/** Data prepared by each route after parsing and translating the request. */
export interface ProxyRequest {
  codexRequest: CodexResponsesRequest;
  model: string;
  isStreaming: boolean;
  /** Stable client-side conversation/session identifier when the upstream client provides one. */
  clientConversationId?: string;
  /** Original schema before tuple→object conversion (for response reconversion). */
  tupleSchema?: Record<string, unknown> | null;
  /** Whether this is a new conversation (no previous_response_id) — used for cache reporting. */
  isNewConversation?: boolean;
  /** True iff the request declared `tools: [{type: "image_generation"}]`.
   *  Used to attribute success/failure to the image_generation request counters
   *  even when the upstream call fails before the first SSE event arrives. */
  expectsImageGen?: boolean;
}

export interface UsageHint {
  reusedInputTokensUpperBound?: number;
}

export interface ResponseMetadata {
  functionCallIds?: string[];
}

/** Format-specific adapter provided by each route. */
export interface FormatAdapter {
  tag: string;
  noAccountStatus: StatusCode;
  formatNoAccount: () => unknown;
  format429: (message: string) => unknown;
  formatError: (status: number, message: string) => unknown;
  formatStreamError?: (status: number, message: string) => string;
  streamTranslator: (
    api: UpstreamAdapter,
    response: Response,
    model: string,
    onUsage: (u: { input_tokens: number; output_tokens: number; cached_tokens?: number; reasoning_tokens?: number; image_input_tokens?: number; image_output_tokens?: number }) => void,
    onResponseId: (id: string) => void,
    tupleSchema?: Record<string, unknown> | null,
    usageHint?: UsageHint,
    onResponseMetadata?: (metadata: ResponseMetadata) => void,
  ) => AsyncGenerator<string>;
  collectTranslator: (
    api: UpstreamAdapter,
    response: Response,
    model: string,
    tupleSchema?: Record<string, unknown> | null,
    usageHint?: UsageHint,
    onResponseMetadata?: (metadata: ResponseMetadata) => void,
  ) => Promise<{
    response: unknown;
    usage: { input_tokens: number; output_tokens: number; cached_tokens?: number; reasoning_tokens?: number; image_input_tokens?: number; image_output_tokens?: number };
    responseId: string | null;
  }>;
}

const MAX_EMPTY_RETRIES = 2;

/** Upper bound on how stale an implicit-resume `previous_response_id` may be.
 *  Must stay in sync with `DEFAULT_POOL_CONFIG.maxAgeMs` (3_300_000 ms) in
 *  `src/proxy/ws-pool.ts`: once the pool rotates the underlying connection,
 *  the upstream LB rehashes to a new backend and any prev id from the old
 *  connection is guaranteed not_found. Beyond this window reusing the id just
 *  costs one failed round-trip plus a strip-and-retry. Anthropic clients
 *  (Claude Code) hit this often because the protocol gives us no explicit
 *  prev id to anchor on. */
const IMPLICIT_RESUME_MAX_AGE_MS = 55 * 60 * 1000;

function normalizeInstructions(instructions: string | null | undefined): string {
  return instructions ?? "";
}

function nonEmptyString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export interface PromptCacheIdentity {
  promptCacheKey: string;
  conversationId: string;
  explicitPromptCacheKey: string | null;
  clientConversationId: string | null;
  derivedConversationId: string | null;
}

export function resolvePromptCacheIdentity(
  codexRequest: CodexResponsesRequest,
  clientConversationId?: string,
  generateFallbackId: () => string = () => crypto.randomUUID(),
): PromptCacheIdentity {
  const explicitPromptCacheKey = nonEmptyString(codexRequest.prompt_cache_key);
  const normalizedClientConversationId = nonEmptyString(clientConversationId);
  const derivedConversationId = deriveStableConversationKey(codexRequest);
  const promptCacheKey =
    explicitPromptCacheKey ??
    normalizedClientConversationId ??
    derivedConversationId ??
    generateFallbackId();

  return {
    promptCacheKey,
    conversationId: promptCacheKey,
    explicitPromptCacheKey,
    clientConversationId: normalizedClientConversationId,
    derivedConversationId,
  };
}

function buildVariantIdentity(
  codexRequest: CodexResponsesRequest,
  identity: PromptCacheIdentity,
): string | null {
  const parts: string[] = [];
  const windowId = nonEmptyString(codexRequest.codexWindowId);
  if (windowId) parts.push(`window:${windowId}`);
  if ((identity.explicitPromptCacheKey || identity.clientConversationId) && identity.derivedConversationId) {
    parts.push(`anchor:${identity.derivedConversationId}`);
  }
  return parts.length > 0 ? parts.join("\x00") : null;
}

/** Strip CodexApiError's "Codex API error (NNN): " prefix so log warns that
 *  already include status= don't duplicate it inside the message body. */
function stripCodexErrorPrefix(msg: string): string {
  return msg.replace(/^Codex API error \(\d+\): /, "");
}

/** Annotate a usage payload with image_generation attempt outcome before
 *  releasing the account, so `recordUsage` can split it into success vs failed
 *  counters. Synthesizes a usage object when the failure path has none. */
function annotateImageGenOutcome(
  usage: UsageInfo | undefined,
  expectsImageGen: boolean | undefined,
): UsageInfo | undefined {
  if (!expectsImageGen) return usage;
  const succeeded = (usage?.image_output_tokens ?? 0) > 0;
  if (usage) {
    return { ...usage, image_request_attempted: true, image_request_succeeded: succeeded };
  }
  return {
    input_tokens: 0,
    output_tokens: 0,
    image_request_attempted: true,
    image_request_succeeded: false,
  };
}

export interface ImplicitResumeOpts {
  implicitPrevRespId: string | null;
  continuationInputStart: number;
  inputLength: number;
  preferredEntryId: string | null;
  acquiredEntryId: string;
  currentInstructions: string | null | undefined;
  storedInstructions: string | null;
  requiredFunctionCallOutputIds?: string[];
  storedFunctionCallIds?: string[];
}

/** Reason why implicit resume was rejected, or null if it would activate.
 *  Returns "no_implicit_prev" when there's no candidate at all (caller can
 *  treat this as "not applicable").
 *
 *  When rejected with `missing_tool_calls` or `unanswered_tool_calls`, also
 *  returns the offending call_ids so the caller can surface them in logs
 *  without recomputing the same set difference. */
export function evaluateImplicitResume(opts: ImplicitResumeOpts):
  | { active: true; reason: null }
  | { active: false; reason: string; missingCallIds?: string[]; unansweredCallIds?: string[] } {
  if (!opts.implicitPrevRespId) return { active: false, reason: "no_implicit_prev" };
  if (opts.continuationInputStart >= opts.inputLength) {
    return { active: false, reason: "cont_start_eq_len" };
  }
  if (!opts.preferredEntryId) return { active: false, reason: "no_pref_entry" };
  if (opts.acquiredEntryId !== opts.preferredEntryId) {
    return { active: false, reason: "acct_mismatch" };
  }
  if (normalizeInstructions(opts.currentInstructions) !== normalizeInstructions(opts.storedInstructions)) {
    return { active: false, reason: "instr_diff" };
  }
  const storedFunctionCallIds = new Set(opts.storedFunctionCallIds ?? []);
  const requiredFunctionCallOutputIds = opts.requiredFunctionCallOutputIds ?? [];
  const missingCallIds = requiredFunctionCallOutputIds.filter((id) => !storedFunctionCallIds.has(id));
  if (missingCallIds.length > 0) {
    return { active: false, reason: "missing_tool_calls", missingCallIds };
  }
  // Reverse check: every stored function_call must be answered in this continuation.
  // Otherwise upstream rejects with "No tool output found for function call call_X".
  const requiredSet = new Set(requiredFunctionCallOutputIds);
  const unansweredCallIds = [...storedFunctionCallIds].filter((id) => !requiredSet.has(id));
  if (unansweredCallIds.length > 0) {
    return { active: false, reason: "unanswered_tool_calls", unansweredCallIds };
  }
  return { active: true, reason: null };
}

export function shouldActivateImplicitResume(opts: ImplicitResumeOpts): boolean {
  return evaluateImplicitResume(opts).active;
}

export function shouldReplayFullInputAfterImplicitResumeError(
  err: unknown,
  implicitResumeActive: boolean,
): err is PreviousResponseWebSocketError {
  return implicitResumeActive && err instanceof PreviousResponseWebSocketError;
}

function getContinuationInputStartIndex(input: CodexResponsesRequest["input"]): number {
  let lastModelOutputIndex = -1;
  for (let i = 0; i < input.length; i++) {
    const item = input[i];
    if ("role" in item) {
      if (item.role === "assistant") lastModelOutputIndex = i;
      continue;
    }
    if (item.type === "function_call") {
      lastModelOutputIndex = i;
    }
  }
  return lastModelOutputIndex >= 0 ? lastModelOutputIndex + 1 : 0;
}

function getFunctionCallOutputIds(input: CodexResponsesRequest["input"]): string[] {
  return input
    .filter((item): item is { type: "function_call_output"; call_id: string; output: string } =>
      !("role" in item) && item.type === "function_call_output")
    .map((item) => item.call_id);
}

/** Sleep if this account had a recent request, to stagger upstream traffic. */
export async function staggerIfNeeded(prevSlotMs: number | null): Promise<void> {
  const intervalMs = getConfig().auth.request_interval_ms;
  if (!intervalMs || prevSlotMs == null) return;
  const elapsed = Date.now() - prevSlotMs;
  const target = jitterInt(intervalMs, 0.3);
  const wait = target - elapsed;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

function buildCodexApi(
  token: string,
  accountId: string | null,
  cookieJar: CookieJar | undefined,
  entryId: string,
  proxyPool?: ProxyPool,
): CodexApi {
  const proxyUrl = proxyPool?.resolveProxyUrl(entryId);
  return new CodexApi(token, accountId, cookieJar, entryId, proxyUrl);
}

function canReturnStreamError(req: ProxyRequest, fmt: FormatAdapter): boolean {
  return req.isStreaming && typeof fmt.formatStreamError === "function";
}

function streamErrorResponse(
  c: Context,
  fmt: FormatAdapter,
  status: number,
  message: string,
): Response {
  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");

  return stream(c, async (s) => {
    await s.write(
      fmt.formatStreamError?.(status, message) ??
        `data: ${JSON.stringify({ error: { message, type: "stream_error" } })}\n\n`,
    );
  });
}

export async function handleProxyRequest(
  c: Context,
  accountPool: AccountPool,
  cookieJar: CookieJar | undefined,
  req: ProxyRequest,
  fmt: FormatAdapter,
  proxyPool?: ProxyPool,
): Promise<Response> {
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
    if (canReturnStreamError(req, fmt)) {
      return streamErrorResponse(
        c,
        fmt,
        fmt.noAccountStatus,
        "No available accounts. All accounts are expired or rate-limited.",
      );
    }
    c.status(fmt.noAccountStatus);
    return c.json(fmt.formatNoAccount());
  }

  let { entryId } = acquired;
  let codexApi = buildCodexApi(acquired.token, acquired.accountId, cookieJar, entryId, proxyPool);
  const triedEntryIds: string[] = [entryId];
  let modelRetried = false;
  let stripAndRetryDone = false;
  let usageInfo: UsageInfo | undefined;
  let capturedResponseId: string | null = null;
  const responseFunctionCallIds = new Set<string>();
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
        c.header("Content-Type", "text/event-stream");
        c.header("Cache-Control", "no-cache");
        c.header("Connection", "keep-alive");

        const capturedEntryId = entryId;
        const capturedApi = codexApi;

        return stream(c, async (s) => {
          s.onAbort(() => {
            console.warn(`[stream-client-abort] rid=${requestId.slice(0, 8)} tag=${fmt.tag} model=${req.model}`);
            abortController.abort();
          });
          const recordStreamAffinity = (): void => {
            if (!capturedResponseId) return;
            affinityMap.record(
              capturedResponseId,
              capturedEntryId,
              chainConversationId,
              upstreamTurnState,
              req.codexRequest.instructions ?? undefined,
              usageInfo?.input_tokens,
              Array.from(responseFunctionCallIds),
              variantHash,
            );
          };
          try {
            await streamResponse(
              s, capturedApi, rawResponse, req.model, fmt,
              (u) => {
                usageInfo = u;
                recordStreamAffinity();
              },
              req.tupleSchema,
              (id) => {
                capturedResponseId = id;
                recordStreamAffinity();
              },
              activeUsageHint,
              (metadata) => {
                for (const callId of metadata.functionCallIds ?? []) {
                  responseFunctionCallIds.add(callId);
                }
                recordStreamAffinity();
              },
              { requestId: requestId.slice(0, 8), tag: fmt.tag },
            );
          } finally {
            abortController.abort();
            recordStreamAffinity();
            if (usageInfo) {
              const uncached = usageInfo.cached_tokens
                ? usageInfo.input_tokens - usageInfo.cached_tokens
                : usageInfo.input_tokens;
              const imgIn = usageInfo.image_input_tokens ?? 0;
              const imgOut = usageInfo.image_output_tokens ?? 0;
              const hitPct = usageInfo.input_tokens > 0
                ? `${((usageInfo.cached_tokens ?? 0) / usageInfo.input_tokens * 100).toFixed(1)}%`
                : "n/a";
              console.log(
                `[${fmt.tag}] Account ${capturedEntryId} | rid=${requestId.slice(0, 8)} | Usage: in=${usageInfo.input_tokens}` +
                (usageInfo.cached_tokens ? ` (cached=${usageInfo.cached_tokens} uncached=${uncached})` : "") +
                ` out=${usageInfo.output_tokens}` +
                (usageInfo.reasoning_tokens ? ` reasoning=${usageInfo.reasoning_tokens}` : "") +
                (imgIn || imgOut ? ` image=${imgIn}/${imgOut}` : "") +
                ` | hit=${hitPct}`,
              );
              if (usageInfo.input_tokens > 10_000) {
                console.warn(
                  `[${fmt.tag}] ⚠ High input token count: ${usageInfo.input_tokens} tokens` +
                  (usageInfo.reasoning_tokens ? ` (reasoning=${usageInfo.reasoning_tokens})` : ""),
                );
              }
            }
            releaseAccount(accountPool, capturedEntryId, annotateImageGenOutcome(usageInfo, req.expectsImageGen), released);
          }
        });
      }

      // ── Non-streaming path (with empty-response retry) ──
      return await handleNonStreaming(
        c,
        accountPool,
        cookieJar,
        req,
        fmt,
        proxyPool,
        codexApi,
        rawResponse,
        entryId,
        abortController,
        released,
        requestId,
        affinityMap,
        chainConversationId,
        upstreamTurnState,
        () => activeUsageHint,
        restoreImplicitResumeRequest,
        buildPoolCtx,
        (nextEntryId, nextApi) => {
          entryId = nextEntryId;
          codexApi = nextApi;
          if (!triedEntryIds.includes(nextEntryId)) triedEntryIds.push(nextEntryId);
        },
        variantHash,
      );
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
        if (canReturnStreamError(req, fmt)) {
          return streamErrorResponse(c, fmt, decision.status, decision.message);
        }
        c.status(decision.status as StatusCode);
        return c.json(fmt.formatError(decision.status, decision.message));
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
        const parts: string[] = [];
        if (summary.rate_limited) parts.push(`${summary.rate_limited} rate-limited`);
        if (summary.expired) parts.push(`${summary.expired} expired`);
        if (summary.banned) parts.push(`${summary.banned} banned`);
        if (summary.disabled) parts.push(`${summary.disabled} disabled`);
        if (summary.quota_exhausted) parts.push(`${summary.quota_exhausted} quota-exhausted`);
        if (summary.refreshing) parts.push(`${summary.refreshing} refreshing`);
        const detail = parts.length
          ? `All accounts exhausted (${parts.join(", ")}). ${decision.message}`
          : `No accounts available. ${decision.message}`;
        const status = decision.status as StatusCode;
        if (canReturnStreamError(req, fmt)) {
          return streamErrorResponse(c, fmt, status, detail);
        }
        c.status(status);
        if (decision.useFormat429) {
          return c.json(fmt.format429(detail));
        }
        return c.json(fmt.formatError(status, detail));
      }

      const retry = acquireAccount(accountPool, req.codexRequest.model, triedEntryIds, fmt.tag);
      if (!retry) {
        const status = decision.status as StatusCode;
        if (canReturnStreamError(req, fmt)) {
          return streamErrorResponse(c, fmt, status, decision.message);
        }
        c.status(status);
        if (decision.useFormat429) {
          return c.json(fmt.format429(decision.message));
        }
        return c.json(fmt.formatError(status, decision.message));
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

// TODO: this signature has grown to 14 positional params with 7 trailing
// optionals. Future work: refactor to an options object so adding a new
// optional doesn't risk callers slotting it into the wrong position.
async function handleNonStreaming(
  c: Context,
  accountPool: AccountPool,
  cookieJar: CookieJar | undefined,
  req: ProxyRequest,
  fmt: FormatAdapter,
  proxyPool: ProxyPool | undefined,
  initialApi: CodexApi,
  initialResponse: Response,
  initialEntryId: string,
  abortController: AbortController,
  released: Set<string>,
  requestId: string,
  affinityMap?: SessionAffinityMap,
  conversationId?: string,
  turnState?: string,
  getUsageHint?: () => UsageHint | undefined,
  restoreImplicitResumeRequest?: () => void,
  buildPoolCtx?: (forEntryId: string) => WsPoolContext | undefined,
  setActiveAccount?: (entryId: string, api: CodexApi) => void,
  variantHash?: string,
): Promise<Response> {
  let currentEntryId = initialEntryId;
  let currentApi = initialApi;
  let currentRawResponse = initialResponse;

  for (let attempt = 1; ; attempt++) {
    try {
      const responseFunctionCallIds = new Set<string>();
      const result = await fmt.collectTranslator(
        currentApi,
        currentRawResponse,
        req.model,
        req.tupleSchema,
        getUsageHint?.(),
        (metadata) => {
          for (const callId of metadata.functionCallIds ?? []) {
            responseFunctionCallIds.add(callId);
          }
        },
      );
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
        const u = result.usage;
        const uncached = u.cached_tokens ? u.input_tokens - u.cached_tokens : u.input_tokens;
        const hitPct = u.input_tokens > 0
          ? `${((u.cached_tokens ?? 0) / u.input_tokens * 100).toFixed(1)}%`
          : "n/a";
        console.log(
          `[${fmt.tag}] Account ${currentEntryId} | rid=${requestId.slice(0, 8)} | Usage: in=${u.input_tokens}` +
          (u.cached_tokens ? ` (cached=${u.cached_tokens} uncached=${uncached})` : "") +
          ` out=${u.output_tokens}` +
          (u.reasoning_tokens ? ` reasoning=${u.reasoning_tokens}` : "") +
          ` | hit=${hitPct}`,
        );
        if (u.input_tokens > 10_000) {
          console.warn(`[${fmt.tag}] ⚠ High input token count: ${u.input_tokens} tokens`);
        }
      }
      releaseAccount(accountPool, currentEntryId, annotateImageGenOutcome(result.usage, req.expectsImageGen), released);
      return c.json(result.response);
    } catch (collectErr) {
      // Upstream FIN'd mid-reasoning (typically gpt-5.5 xhigh > 120 s cap).
      // Cross-account retry would re-hit the same cap and burn the pool, so
      // we fail fast with 504. The proxy can't recover this — the client
      // needs to lower reasoning effort or pick a different model.
      if (collectErr instanceof UpstreamPrematureCloseError) {
        const email = accountPool.getEntry(currentEntryId)?.email ?? "?";
        console.warn(
          `[${fmt.tag}] Account ${currentEntryId} (${email}) | upstream premature close (hadReasoning=${collectErr.hadReasoning} events=${collectErr.eventCount}) — failing fast, not retrying`,
        );
        releaseAccount(accountPool, currentEntryId, annotateImageGenOutcome(undefined, req.expectsImageGen), released);
        c.status(504);
        return c.json(fmt.formatError(504, collectErr.message));
      }

      if (collectErr instanceof EmptyResponseError && attempt <= MAX_EMPTY_RETRIES) {
        const email = accountPool.getEntry(currentEntryId)?.email ?? "?";
        console.warn(
          `[${fmt.tag}] Account ${currentEntryId} (${email}) | Empty response (attempt ${attempt}/${MAX_EMPTY_RETRIES + 1}), switching account...`,
        );
        accountPool.recordEmptyResponse(currentEntryId);
        releaseAccount(accountPool, currentEntryId, annotateImageGenOutcome(collectErr.usage, req.expectsImageGen), released);
        restoreImplicitResumeRequest?.();

        const newAcquired = acquireAccount(accountPool, req.codexRequest.model, undefined, fmt.tag);
        if (!newAcquired) {
          c.status(502);
          return c.json(fmt.formatError(502, "Codex returned an empty response and no other accounts are available for retry"));
        }

        currentEntryId = newAcquired.entryId;
        currentApi = buildCodexApi(newAcquired.token, newAcquired.accountId, cookieJar, newAcquired.entryId, proxyPool);
        setActiveAccount?.(currentEntryId, currentApi);
        const retryStartMs = Date.now();
        try {
          currentRawResponse = await withRetry(
            () => currentApi.createResponse(req.codexRequest, abortController.signal, undefined, buildPoolCtx?.(currentEntryId)),
            { tag: fmt.tag },
          );
          enqueueLogEntry({
            requestId,
            direction: "egress",
            method: "POST",
            path: "/codex/responses",
            model: req.model,
            provider: "codex",
            status: currentRawResponse.status,
            latencyMs: Date.now() - retryStartMs,
            stream: req.isStreaming,
            request: {
              model: req.codexRequest.model,
              stream: req.codexRequest.stream,
              useWebSocket: req.codexRequest.useWebSocket,
            },
          });
        } catch (retryErr) {
          releaseAccount(accountPool, currentEntryId, annotateImageGenOutcome(undefined, req.expectsImageGen), released);
          const msg = retryErr instanceof Error ? retryErr.message : "Upstream request failed";
          enqueueLogEntry({
            requestId,
            direction: "egress",
            method: "POST",
            path: "/codex/responses",
            model: req.model,
            provider: "codex",
            status: retryErr instanceof CodexApiError ? retryErr.status : null,
            latencyMs: Date.now() - retryStartMs,
            stream: req.isStreaming,
            error: msg,
            request: {
              model: req.codexRequest.model,
              stream: req.codexRequest.stream,
              useWebSocket: req.codexRequest.useWebSocket,
            },
          });
          if (retryErr instanceof CodexApiError) {
            const code = toErrorStatus(retryErr.status);
            c.status(code);
            return c.json(fmt.formatError(code, retryErr.message));
          }
          throw retryErr;
        }
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

/**
 * Lightweight handler for API-key-based upstreams (OpenAI, Anthropic, Gemini, custom).
 * No account pool management, no session affinity, no retry logic — just proxy + translate.
 */
export async function handleDirectRequest(
  c: Context,
  upstream: UpstreamAdapter,
  req: ProxyRequest,
  fmt: FormatAdapter,
): Promise<Response> {
  const abortController = new AbortController();
  c.req.raw.signal.addEventListener("abort", () => abortController.abort(), { once: true });

  const requestId = c.get("requestId") ?? randomUUID().slice(0, 8);
  const startMs = Date.now();
  let rawResponse: Response;
  try {
    rawResponse = await upstream.createResponse(req.codexRequest, abortController.signal);
    enqueueLogEntry({
      requestId,
      direction: "egress",
      method: "POST",
      path: "/v1/responses",
      model: req.model,
      provider: upstream.tag,
      status: rawResponse.status,
      latencyMs: Date.now() - startMs,
      stream: req.isStreaming,
      request: {
        model: req.codexRequest.model,
        stream: req.codexRequest.stream,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Upstream request failed";
    const status = err instanceof CodexApiError ? err.status : 502;
    enqueueLogEntry({
      requestId,
      direction: "egress",
      method: "POST",
      path: "/v1/responses",
      model: req.model,
      provider: upstream.tag,
      status,
      latencyMs: Date.now() - startMs,
      stream: req.isStreaming,
      error: msg,
      request: {
        model: req.codexRequest.model,
        stream: req.codexRequest.stream,
      },
    });
    if (err instanceof CodexApiError) {
      const code = toErrorStatus(err.status) as StatusCode;
      if (canReturnStreamError(req, fmt)) {
        return streamErrorResponse(c, fmt, code, err.message);
      }
      c.status(code);
      // For API-key upstreams, forward the raw upstream error body transparently
      try {
        const parsed: unknown = JSON.parse(err.body);
        if (parsed && typeof parsed === "object") {
          return c.json(parsed);
        }
      } catch { /* non-JSON body — fall through */ }
      if (code === 429) {
        return c.json(fmt.format429(err.message));
      }
      return c.json(fmt.formatError(code, err.message));
    }
    if (canReturnStreamError(req, fmt)) {
      return streamErrorResponse(c, fmt, 502, msg);
    }
    c.status(502);
    return c.json(fmt.formatError(502, msg));
  }

  if (req.isStreaming) {
    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");

    return stream(c, async (s) => {
      s.onAbort(() => {
        console.warn(`[stream-client-abort] rid=${requestId.slice(0, 8)} tag=${fmt.tag} model=${req.model}`);
        abortController.abort();
      });
      await streamResponse(
        s,
        upstream,
        rawResponse,
        req.model,
        fmt,
        () => {},
        req.tupleSchema,
        () => {},
        undefined,
        undefined,
        { requestId: requestId.slice(0, 8), tag: fmt.tag },
      );
    });
  }

  // Non-streaming
  try {
    const result = await fmt.collectTranslator(upstream, rawResponse, req.model, req.tupleSchema);
    return c.json(result.response);
  } catch (err) {
    abortController.abort();
    const msg = err instanceof Error ? err.message : "Failed to collect upstream response";
    const code = toErrorStatus(0) as StatusCode;
    c.status(code);
    return c.json(fmt.formatError(code, msg));
  }
}
