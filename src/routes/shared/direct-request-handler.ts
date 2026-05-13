/**
 * Direct upstream handler for API-key-based upstreams (OpenAI, Anthropic,
 * Gemini, custom). This path has no account pool management, no session
 * affinity, and no retry logic; it only proxies the translated request and
 * translates the upstream response back to the route format.
 */

import type { StatusCode } from "hono/utils/http-status";
import { stream } from "hono/streaming";
import { CodexApiError } from "../../proxy/codex-api.js";
import { randomUUID } from "crypto";
import { enqueueLogEntry } from "../../logs/entry.js";
import { recordStreamCloseEvent } from "../../logs/stream-close-event.js";
import { streamResponse } from "./response-processor.js";
import { toErrorStatus } from "./proxy-error-handler.js";
import type { HandleDirectRequestOptions } from "./proxy-handler-types.js";
import { canReturnStreamError, streamErrorResponse } from "./stream-error-response.js";

export async function handleDirectRequest(options: HandleDirectRequestOptions): Promise<Response> {
  const { c, upstream, req, fmt } = options;
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

    return stream(c, async (s) => {
      s.onAbort(() => {
        console.warn(`[stream-client-abort] rid=${requestId.slice(0, 8)} tag=${fmt.tag} model=${req.model}`);
        recordStreamCloseEvent({
          kind: "client-abort",
          requestId,
          tag: fmt.tag,
          provider: upstream.tag,
          path: "/v1/responses",
          model: req.model,
        });
        abortController.abort();
      });
      await streamResponse({
        writer: s,
        api: upstream,
        response: rawResponse,
        model: req.model,
        adapter: fmt,
        onUsage: () => {},
        tupleSchema: req.tupleSchema,
        onResponseId: () => {},
        diagnostics: {
          requestId: requestId.slice(0, 8),
          tag: fmt.tag,
          provider: upstream.tag,
          path: "/v1/responses",
          abortSignal: abortController.signal,
        },
      });
    });
  }

  try {
    const result = await fmt.collectTranslator({
      api: upstream,
      response: rawResponse,
      model: req.model,
      tupleSchema: req.tupleSchema,
    });
    return c.json(result.response);
  } catch (err) {
    abortController.abort();
    const msg = err instanceof Error ? err.message : "Failed to collect upstream response";
    const code = toErrorStatus(0) as StatusCode;
    c.status(code);
    return c.json(fmt.formatError(code, msg));
  }
}
