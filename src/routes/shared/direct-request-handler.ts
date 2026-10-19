/**
 * Direct upstream handler for API-key-based upstreams (OpenAI, Anthropic,
 * Gemini, custom). This path has no account pool management, no session
 * affinity, and no retry logic; it only proxies the translated request and
 * translates the upstream response back to the route format.
 */

import type { StatusCode } from "hono/utils/http-status";
import { stream } from "hono/streaming";
import { CodexApiError, PreviousResponseWebSocketError } from "../../proxy/codex-api.js";
import type { UpstreamAdapter } from "../../proxy/upstream-adapter.js";
import { randomUUID } from "crypto";
import { enqueueLogEntry, updateLogEntry } from "../../logs/entry.js";
import { calculateLogMetrics } from "../../logs/metrics.js";
import type { UsageInfo } from "../../translation/codex-event-extractor.js";
import { recordStreamCloseEvent } from "../../logs/stream-close-event.js";
import { appendErrorLog } from "../../logs/error-log.js";
import { streamResponse } from "./response-processor.js";
import { toErrorStatus } from "./proxy-error-handler.js";
import type { HandleDirectRequestOptions, ProxyRequest } from "./proxy-handler-types.js";
import { canReturnStreamError, streamErrorResponse } from "./stream-error-response.js";
import { recordClientKeyUsage, upstreamModelOf } from "./proxy-handler-utils.js";
import { extractPolicyErrorCode, isPolicyRejection } from "../../proxy/policy-rejection.js";
import { peekConversationQuarantine, recordConversationQuarantine } from "../../proxy/conversation-quarantine.js";
import { resolvePromptCacheIdentity } from "./proxy-session-helpers.js";
import { createResponseMetadataCollector } from "./response-metadata-collector.js";

/** Transport-level failures (status 0) get bounded retries: weak networks
 *  produce transient connection errors routinely, and the direct path has no
 *  account-rotation fallback to absorb them. Bounded small — a persistent
 *  outage must fail fast, and only pre-response failures are replayed. */
const TRANSPORT_RETRY_MAX = 2;
const TRANSPORT_RETRY_BASE_MS = 250;

function isTransportFailure(err: unknown): boolean {
  // Continuity failures also carry status 0 but are managed by dedicated
  // recovery paths — they must not consume the transport retry budget.
  return err instanceof CodexApiError
    && err.status === 0
    && !(err instanceof PreviousResponseWebSocketError);
}

/** The code/message pair to remember for a rejection thrown as an error. */
function policyRejectionFacts(err: unknown): { code?: string; message: string } {
  return {
    code: extractPolicyErrorCode(err instanceof CodexApiError ? err.body : ""),
    message: err instanceof Error ? err.message : String(err),
  };
}

/**
 * Remember a safety-policy rejection so later turns of the same conversation
 * are refused locally. The direct path has no retry loop and no account
 * rotation to amplify a rejection, but the client's own retry and its
 * autonomous "goal"-mode continuations arrive as brand-new requests on this
 * same path — and every resend reports another violation upstream.
 */
function quarantineRejectedConversation(
  conversationId: string,
  req: ProxyRequest,
  rejection: { code?: string; message: string },
): void {
  recordConversationQuarantine({
    conversationId,
    input: req.codexRequest.input,
    code: rejection.code,
    message: rejection.message,
  });
  console.warn(
    `[policy-quarantine] conversation ${conversationId.slice(0, 8)} quarantined after an upstream `
    + "safety-policy rejection — later turns are refused locally",
  );
}

/**
 * Create the upstream response with bounded transport retry. A status-0
 * CodexApiError means the request never completed at the transport layer
 * (connect refused/reset, DNS, connection closed before response) — replaying
 * the full request is safe and matches the account path's cross-account
 * replay semantics.
 */
async function createResponseWithTransportRetry(
  upstream: UpstreamAdapter,
  req: ProxyRequest,
  signal: AbortSignal,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await upstream.createResponse(req.codexRequest, signal);
    } catch (err) {
      if (!isTransportFailure(err)
        || attempt >= TRANSPORT_RETRY_MAX
        || signal.aborted) {
        throw err;
      }
      const delayMs = TRANSPORT_RETRY_BASE_MS * 2 ** attempt;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[direct:${upstream.tag}] upstream transport failure, `
        + `retry ${attempt + 1}/${TRANSPORT_RETRY_MAX} in ${delayMs}ms: ${msg.slice(0, 160)}`,
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

export async function handleDirectRequest(options: HandleDirectRequestOptions): Promise<Response> {
  const { c, upstream, req, fmt } = options;
  const abortController = new AbortController();
  // addEventListener never fires for an already-aborted signal — a client
  // that aborted before reaching the handler must still stop work.
  if (c.req.raw.signal.aborted) {
    abortController.abort();
  } else {
    c.req.raw.signal.addEventListener("abort", () => abortController.abort(), { once: true });
  }

  const requestId = c.get("requestId") ?? randomUUID().slice(0, 8);
  const startMs = Date.now();
  // The proxy routes through this direct handler when all OAuth accounts are
  // exhausted and a fallback upstream apikey is configured. Mark those calls
  // so the audit log can surface "fallback" instead of an account name.
  const isFallback = upstream.tag === "fallback";
  const accountLog = isFallback ? "fallback" : options.account;
  const upstreamPath = upstream.logPath ?? "/v1/responses";

  // ── Safety-policy quarantine ──
  // The upstream safety gate answers as a function of the content, so a
  // conversation it already rejected cannot succeed on this path either (a
  // custom provider, an API-key upstream, or the account-less fallback leg).
  // The account path — the one this handler is reached from when no account is
  // available — runs the same check; without it here, a rejection relayed
  // through a custom provider would be resent on every later turn.
  const conversationId = resolvePromptCacheIdentity(
    req.codexRequest,
    req.clientConversationId,
  ).conversationId;
  const quarantine = peekConversationQuarantine({
    conversationId,
    input: req.codexRequest.input,
  });
  if (quarantine.blocked) {
    const message = quarantine.message ?? "Upstream safety policy rejected this conversation.";
    console.warn(
      `[${fmt.tag}] conversation ${conversationId.slice(0, 8)} is quarantined after an upstream `
      + `safety-policy rejection (${upstream.tag}) — refusing locally without contacting upstream`,
    );
    c.status(400);
    if (canReturnStreamError(req, fmt)) {
      return streamErrorResponse(c, fmt, 400, message);
    }
    return c.json(fmt.formatError(400 as StatusCode, message));
  }

  let rawResponse: Response;
  try {
    rawResponse = await createResponseWithTransportRetry(upstream, req, abortController.signal);
    enqueueLogEntry({
      requestId,
      direction: "egress",
      method: "POST",
      path: upstreamPath,
      model: upstreamModelOf(req),
      provider: upstream.tag,
      account: accountLog,
      fallback: isFallback,
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
      path: upstreamPath,
      model: upstreamModelOf(req),
      provider: upstream.tag,
      account: accountLog,
      fallback: isFallback,
      status,
      latencyMs: Date.now() - startMs,
      stream: req.isStreaming,
      error: msg,
      request: {
        model: req.codexRequest.model,
        stream: req.codexRequest.stream,
      },
    });
    // A rejection that got a status instead of a stream frame (relays answer
    // with a plain 4xx/5xx JSON body) lands here. Report it as a 400 like the
    // account path does — not as the raw upstream status, which a client is
    // free to retry — and quarantine the conversation.
    if (isPolicyRejection(err)) {
      quarantineRejectedConversation(conversationId, req, policyRejectionFacts(err));
      c.status(400);
      if (canReturnStreamError(req, fmt)) {
        return streamErrorResponse(c, fmt, 400, msg);
      }
      return c.json(fmt.formatError(400 as StatusCode, msg));
    }
    // Persist terminal direct-upstream errors (with truncated body) so
    // Gemini/Anthropic-passthrough failures are debuggable from disk.
    appendErrorLog({
      source: "server",
      error: {
        name: err instanceof Error ? err.name : "DirectUpstreamError",
        message: msg,
        stack: err instanceof Error ? err.stack : undefined,
      },
      context: {
        requestId,
        model: req.model,
        provider: upstream.tag,
        status,
        upstreamBody: err instanceof CodexApiError ? truncateBody(err.body) : undefined,
      },
    });
    if (err instanceof CodexApiError) {
      const code = toErrorStatus(err.status) as StatusCode;
      c.status(code);
      if (code === 429) {
        const retryAfter = err.headers?.get("retry-after");
        if (retryAfter) c.header("Retry-After", retryAfter);
      }
      if (canReturnStreamError(req, fmt)) {
        return streamErrorResponse(c, fmt, code, err.message);
      }
      // For API-key upstreams, forward the raw upstream error body transparently.
      try {
        const parsed: unknown = JSON.parse(err.body);
        if (parsed && typeof parsed === "object") {
          return c.json(parsed);
        }
      } catch { /* non-JSON body: fall through */ }
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
    // Disable response buffering on nginx-class reverse proxies so SSE
    // heartbeats and deltas reach the client immediately.
    c.header("X-Accel-Buffering", "no");

    return stream(c, async (s) => {
      let usageInfo: UsageInfo | null = null;
      let firstTokenMs: number | null = null;
      let clientAborted = false;
      const metadataCollector = createResponseMetadataCollector();
      s.onAbort(() => {
        clientAborted = true;
        console.warn(`[stream-client-abort] rid=${requestId.slice(0, 8)} tag=${fmt.tag} model=${req.model}`);
        recordStreamCloseEvent({
          kind: "client-abort",
          requestId,
          tag: fmt.tag,
          provider: upstream.tag,
          path: upstreamPath,
          model: upstreamModelOf(req),
          fallback: isFallback,
        });
        abortController.abort();
      });
      try {
        await streamResponse({
          writer: s,
          api: upstream,
          response: rawResponse,
          model: req.model,
          upstreamModel: upstreamModelOf(req),
          adapter: fmt,
          onUsage: (u) => {
            usageInfo = u;
            options.onUsage?.(u);
            recordClientKeyUsage(c, req.model, u);
          },
          tupleSchema: req.tupleSchema,
          onResponseId: () => {},
          onResponseMetadata: (metadata) => metadataCollector.onResponseMetadata(metadata),
          onFirstToken: (ts) => {
            firstTokenMs = ts;
          },
          diagnostics: {
            requestId: requestId.slice(0, 8),
            tag: fmt.tag,
            provider: upstream.tag,
            path: upstreamPath,
            fallback: isFallback,
            abortSignal: abortController.signal,
          },
        });
      } finally {
        // A terminal safety-policy frame arrives *inside* the stream, so it
        // never reaches a catch block — the client can send its next turn as
        // soon as it reads the frame. Record the quarantine here so that turn
        // is refused locally instead of being relayed upstream again.
        if (metadataCollector.policyRejection) {
          quarantineRejectedConversation(conversationId, req, metadataCollector.policyRejection);
        }
        const metrics = calculateLogMetrics({
          startMs,
          firstTokenMs,
          endMs: Date.now(),
          model: req.model,
          usage: usageInfo,
          isStreaming: true,
        });
        c.set("metrics", metrics);
        updateLogEntry(requestId, {
          status: clientAborted ? 499 : rawResponse.status,
          account: accountLog,
          fallback: isFallback,
          latencyMs: metrics.durationMs,
          ttftMs: metrics.ttftMs,
          durationMs: metrics.durationMs,
          costUsd: metrics.costUsd,
          tokensPerSecond: metrics.tokensPerSecond,
          usage: usageInfo,
          metrics,
        });
      }
    });
  }

  try {
    const result = await fmt.collectTranslator({
      api: upstream,
      response: rawResponse,
      model: req.model,
      tupleSchema: req.tupleSchema,
    });
    if (result.usage) options.onUsage?.(result.usage);
    recordClientKeyUsage(c, req.model, result.usage);
    const metrics = calculateLogMetrics({
      startMs,
      endMs: Date.now(),
      model: req.model,
      usage: result.usage,
      isStreaming: false,
    });
    c.set("metrics", metrics);
    updateLogEntry(requestId, {
      status: rawResponse.status,
      account: accountLog,
      fallback: isFallback,
      latencyMs: metrics.durationMs,
      ttftMs: metrics.ttftMs,
      durationMs: metrics.durationMs,
      costUsd: metrics.costUsd,
      tokensPerSecond: metrics.tokensPerSecond,
      usage: result.usage,
      metrics,
    });
    return c.json(result.response);
  } catch (err) {
    abortController.abort();
    const msg = err instanceof Error ? err.message : "Failed to collect upstream response";
    const code = toErrorStatus(0) as StatusCode;
    c.status(code);
    updateLogEntry(requestId, {
      status: code,
      account: accountLog,
      fallback: isFallback,
      error: msg,
      latencyMs: Date.now() - startMs,
    });
    appendErrorLog({
      source: "server",
      error: {
        name: err instanceof Error ? err.name : "DirectUpstreamCollectError",
        message: msg,
        stack: err instanceof Error ? err.stack : undefined,
      },
      context: { requestId, model: req.model, provider: upstream.tag, status: code },
    });
    // Non-streaming rejections surface as a thrown `Codex API error: <code>:
    // <message>` — the code is the same signal the streaming frame carries,
    // so the same quarantine applies (and the client must not see a retryable
    // status for a verdict that is a function of the content).
    if (isPolicyRejection(err)) {
      quarantineRejectedConversation(conversationId, req, policyRejectionFacts(err));
      c.status(400);
      return c.json(fmt.formatError(400 as StatusCode, msg));
    }
    return c.json(fmt.formatError(code, msg));
  }
}

/** Bound upstream error bodies so a single error-log line stays reasonable. */
function truncateBody(body: unknown): unknown {
  if (body === undefined || body === null) return body;
  let serialized: string | undefined;
  try {
    serialized = typeof body === "string" ? body : JSON.stringify(body);
  } catch {
    return "[unserializable]";
  }
  if (serialized === undefined) return "[unserializable]";
  return serialized.length > 4096
    ? serialized.slice(0, 4096) + `…[truncated ${serialized.length - 4096} chars]`
    : serialized;
}
