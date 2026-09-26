/**
 * Tests for transport-level retry (status-0 CodexApiError) in
 * handleDirectRequest — the direct api-key path has no account rotation, so
 * transient connection failures must be absorbed by bounded retries.
 */

import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { CodexApiError } from "@src/proxy/codex-api.js";
import type { FormatAdapter, ProxyRequest } from "@src/routes/shared/proxy-handler-types.js";
import { handleDirectRequest } from "@src/routes/shared/direct-request-handler.js";
import { createMockFormatAdapter } from "@helpers/format-adapter.js";

function makeRequest(overrides: Partial<ProxyRequest> = {}): ProxyRequest {
  return {
    model: "client-model",
    isStreaming: false,
    codexRequest: {
      model: "codex-model",
      input: [{ role: "user", content: "hello" }],
      instructions: "system",
      stream: true,
      store: false,
    },
    ...overrides,
  };
}

function makeUpstream(failTimes: number, err: CodexApiError) {
  const createResponse = vi.fn(async (): Promise<Response> => {
    if (failTimes > 0) {
      failTimes -= 1;
      throw err;
    }
    return new Response("data: {}\n\n", { status: 200 });
  });
  return { upstream: { tag: "codex-responses", createResponse }, createResponse };
}

async function drive(upstream: unknown, req: ProxyRequest, fmt: FormatAdapter): Promise<Response> {
  const app = new Hono();
  app.post("/test", (c) => handleDirectRequest({ c: c as never, upstream: upstream as never, req, fmt }));
  return app.request("/test", { method: "POST" });
}

describe("handleDirectRequest transport retry", () => {
  it("retries a transient status-0 failure and succeeds", async () => {
    const { upstream, createResponse } = makeUpstream(1, new CodexApiError(0, "connection reset"));
    const fmt = createMockFormatAdapter();

    const res = await drive(upstream, makeRequest(), fmt);

    expect(res.status).toBe(200);
    expect(createResponse).toHaveBeenCalledTimes(2);
  });

  it("gives up after the bounded retries and surfaces 502", async () => {
    const { upstream, createResponse } = makeUpstream(99, new CodexApiError(0, "connection refused"));
    const fmt = createMockFormatAdapter();

    const res = await drive(upstream, makeRequest(), fmt);
    const body = await res.json() as { status?: number };

    expect(res.status).toBe(502);
    // 1 initial attempt + 2 retries
    expect(createResponse).toHaveBeenCalledTimes(3);
    expect(body.status).toBe(502);
  }, 10_000);

  it("does not retry upstream HTTP-status errors", async () => {
    const { upstream, createResponse } = makeUpstream(99, new CodexApiError(429, "{}"));
    const fmt = createMockFormatAdapter();

    const res = await drive(upstream, makeRequest(), fmt);
    // JSON-parseable upstream error bodies are forwarded transparently.
    const body = await res.json();

    expect(res.status).toBe(429);
    expect(createResponse).toHaveBeenCalledTimes(1);
    expect(body).toEqual({});
    expect(fmt.format429).not.toHaveBeenCalled();
  });

  it("does not retry when the client already aborted", async () => {
    const { upstream, createResponse } = makeUpstream(99, new CodexApiError(0, "connection reset"));
    const fmt = createMockFormatAdapter();

    const app = new Hono();
    app.post("/test", (c) => handleDirectRequest({ c: c as never, upstream: upstream as never, req: makeRequest(), fmt }));

    // Pre-aborted signal: the wired abort listener marks the retry loop's
    // signal aborted, so the first transport failure must surface immediately.
    const controller = new AbortController();
    controller.abort();
    const res = await app.request("/test", {
      method: "POST",
      signal: controller.signal,
    });

    expect(res.status).toBe(502);
    expect(createResponse).toHaveBeenCalledTimes(1);
  });
});
