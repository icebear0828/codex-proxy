/**
 * Tests for ws-transport early-stream error rejection.
 *
 * Regression: when the upstream WebSocket sends a terminal error frame
 * (e.g. `usage_limit_reached`) as the first observable message,
 * `createWebSocketResponse` must reject with a `CodexApiError` so that the
 * proxy-handler's existing rotation flow can switch to a different account
 * — instead of resolving with HTTP 200 and streaming the error to the
 * client, which bypasses rotation entirely (the bug fixed in this PR).
 */

import { EventEmitter } from "node:events";

const wsInstances = vi.hoisted(() => [] as EventEmitter[]);

vi.mock("ws", () => {
  const { EventEmitter: EE } = require("node:events") as typeof import("node:events");

  class MockWebSocket extends EE {
    readyState = 0;
    sentMessages: string[] = [];

    constructor(_url: string, _opts?: Record<string, unknown>) {
      super();
      wsInstances.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.emit("open");
      });
    }

    send(data: string) {
      this.sentMessages.push(data);
    }

    close(_code?: number, _reason?: string) {
      this.readyState = 3;
      queueMicrotask(() => this.emit("close", 1000, Buffer.from("")));
    }
  }

  return { default: MockWebSocket };
});

import { describe, it, expect, vi, beforeEach } from "vitest";

import { createWebSocketResponse, type WsCreateRequest } from "@src/proxy/ws-transport.js";
import { CodexApiError } from "@src/proxy/codex-types.js";
import { extractRetryAfterSec } from "@src/proxy/error-classification.js";

interface MockWs extends EventEmitter {
  readyState: number;
  sentMessages: string[];
  close(code?: number, reason?: string): void;
}

const BASE_REQUEST: WsCreateRequest = {
  type: "response.create",
  model: "gpt-5.3-codex",
  instructions: "test",
  input: [{ role: "user", content: "hi" }],
};

function lastWs(): MockWs {
  return wsInstances[wsInstances.length - 1] as MockWs;
}

async function waitForOpen(): Promise<MockWs> {
  for (let i = 0; i < 50; i++) {
    if (wsInstances.length > 0) {
      const ws = wsInstances[wsInstances.length - 1] as MockWs;
      if (ws.readyState === 1 && ws.sentMessages.length > 0) return ws;
    }
    await new Promise<void>((r) => setTimeout(r, 0));
  }
  throw new Error("WebSocket did not open within timeout");
}

async function readAll(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

describe("createWebSocketResponse — early-stream error rejection", () => {
  beforeEach(() => {
    wsInstances.length = 0;
  });

  it("rejects with CodexApiError(429) when first frame is usage_limit_reached", async () => {
    const promise = createWebSocketResponse("wss://test/ws", {}, BASE_REQUEST);
    promise.catch(() => { /* asserted below */ });
    const ws = await waitForOpen();

    const errorFrame = {
      type: "error",
      error: {
        code: "usage_limit_reached",
        message: "The usage limit has been reached",
        resets_in_seconds: 60,
      },
    };
    ws.emit("message", JSON.stringify(errorFrame));

    await expect(promise).rejects.toBeInstanceOf(CodexApiError);
    try {
      await promise;
    } catch (err) {
      expect(err).toBeInstanceOf(CodexApiError);
      const apiErr = err as CodexApiError;
      expect(apiErr.status).toBe(429);
      // The body must contain the upstream `error` block so that
      // `extractRetryAfterSec` can read `resets_in_seconds` for backoff.
      expect(extractRetryAfterSec(apiErr.body)).toBe(60);
    }
  });

  it("rejects with CodexApiError(402) when first frame is response.failed quota_exhausted", async () => {
    const promise = createWebSocketResponse("wss://test/ws", {}, BASE_REQUEST);
    promise.catch(() => { /* asserted below */ });
    const ws = await waitForOpen();

    ws.emit("message", JSON.stringify({
      type: "response.failed",
      error: { code: "quota_exhausted", message: "Plan exhausted" },
      response: { id: "resp_x" },
    }));

    try {
      await promise;
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(CodexApiError);
      expect((err as CodexApiError).status).toBe(402);
    }
  });

  it("resolves normally when first frame is an error with an unmapped code", async () => {
    // Genuine model errors (e.g. invalid request, model_not_supported_in_plan)
    // must NOT trigger rotation — they keep the SSE pass-through behavior so
    // the client sees the real reason instead of cycling through accounts.
    const promise = createWebSocketResponse("wss://test/ws", {}, BASE_REQUEST);
    const ws = await waitForOpen();

    const errorFrame = {
      type: "error",
      error: { code: "model_not_supported_in_plan", message: "nope" },
    };
    ws.emit("message", JSON.stringify(errorFrame));

    const response = await promise;
    expect(response.status).toBe(200);
    const text = await readAll(response);
    expect(text).toContain("event: error");
    expect(text).toContain("model_not_supported_in_plan");
  });

  it("treats codex.rate_limits as internal — does not flip the early-decision flag", async () => {
    // Sequence: rate-limits frame → usage_limit_reached error.
    // The rate-limits frame must be consumed via onRateLimits and must NOT
    // resolve the promise; the subsequent error frame must still trigger
    // CodexApiError rejection.
    const onRateLimits = vi.fn();
    const promise = createWebSocketResponse(
      "wss://test/ws",
      {},
      BASE_REQUEST,
      undefined,
      undefined,
      onRateLimits,
    );
    promise.catch(() => { /* asserted below */ });
    const ws = await waitForOpen();

    ws.emit("message", JSON.stringify({
      type: "codex.rate_limits",
      rate_limits: {
        primary: { used_percent: 50, window_minutes: 60, resets_in_seconds: 1800 },
        secondary: { used_percent: 10, window_minutes: 10080, resets_in_seconds: 5_000_000 },
      },
    }));
    ws.emit("message", JSON.stringify({
      type: "error",
      error: { code: "usage_limit_reached", message: "Limit reached" },
    }));

    try {
      await promise;
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(CodexApiError);
      expect((err as CodexApiError).status).toBe(429);
    }
    // onRateLimits was called for the codex.rate_limits frame.
    expect(onRateLimits).toHaveBeenCalledTimes(1);
  });

  it("passes through error events that arrive after a real frame", async () => {
    // Once a real frame has been streamed, switching accounts is no longer
    // safe — the client has already started receiving bytes. Errors arriving
    // mid-stream must keep the existing SSE pass-through behavior.
    const promise = createWebSocketResponse("wss://test/ws", {}, BASE_REQUEST);
    const ws = await waitForOpen();

    ws.emit("message", JSON.stringify({ type: "response.created", response: { id: "resp_1" } }));
    const response = await promise;
    expect(response.status).toBe(200);

    ws.emit("message", JSON.stringify({
      type: "error",
      error: { code: "usage_limit_reached", message: "Limit reached" },
    }));

    const text = await readAll(response);
    expect(text).toContain("event: response.created");
    expect(text).toContain("event: error");
    expect(text).toContain("usage_limit_reached");
  });

  it("rejects when the WebSocket closes before any data frame", async () => {
    const promise = createWebSocketResponse("wss://test/ws", {}, BASE_REQUEST);
    promise.catch(() => { /* asserted below */ });
    const ws = await waitForOpen();

    ws.emit("close", 1006, Buffer.from("upstream gone"));

    try {
      await promise;
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("WebSocket closed before any data");
      expect((err as Error).message).toContain("code=1006");
    }
  });
});
