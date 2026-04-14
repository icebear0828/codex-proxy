/**
 * Tests for parseRateLimitsEvent — extracts quota from the
 * `codex.rate_limits` WebSocket SSE event payload.
 *
 * Also tests the WS transport integration: callback invocation + event suppression.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseRateLimitsEvent, type ParsedRateLimit } from "@src/proxy/rate-limit-headers.js";

describe("parseRateLimitsEvent", () => {
  it("parses a full codex.rate_limits event with primary + secondary", () => {
    const data = {
      type: "codex.rate_limits",
      plan_type: "plus",
      rate_limits: {
        primary: { used_percent: 42.0, window_minutes: 300, reset_at: 1700000000 },
        secondary: { used_percent: 18.0, window_minutes: 10080, reset_at: 1700500000 },
      },
    };
    const result = parseRateLimitsEvent(data);
    expect(result).toEqual({
      primary: { used_percent: 42.0, window_minutes: 300, reset_at: 1700000000 },
      secondary: { used_percent: 18.0, window_minutes: 10080, reset_at: 1700500000 },
    });
  });

  it("parses event with only primary window", () => {
    const data = {
      type: "codex.rate_limits",
      rate_limits: {
        primary: { used_percent: 80.5, window_minutes: 300, reset_at: 1700000000 },
      },
    };
    const result = parseRateLimitsEvent(data);
    expect(result).toEqual({
      primary: { used_percent: 80.5, window_minutes: 300, reset_at: 1700000000 },
      secondary: null,
    });
  });

  it("parses event with only secondary window", () => {
    const data = {
      type: "codex.rate_limits",
      rate_limits: {
        secondary: { used_percent: 50.0, window_minutes: 10080, reset_at: 1700500000 },
      },
    };
    const result = parseRateLimitsEvent(data);
    expect(result).toEqual({
      primary: null,
      secondary: { used_percent: 50.0, window_minutes: 10080, reset_at: 1700500000 },
    });
  });

  it("returns null for missing rate_limits field", () => {
    expect(parseRateLimitsEvent({ type: "codex.rate_limits" })).toBeNull();
    expect(parseRateLimitsEvent({})).toBeNull();
    expect(parseRateLimitsEvent(null)).toBeNull();
    expect(parseRateLimitsEvent("string")).toBeNull();
  });

  it("returns null when rate_limits has no windows", () => {
    expect(parseRateLimitsEvent({ rate_limits: {} })).toBeNull();
    expect(parseRateLimitsEvent({ rate_limits: { primary: null } })).toBeNull();
  });

  it("handles missing optional fields in window", () => {
    const data = {
      rate_limits: {
        primary: { used_percent: 10 },
      },
    };
    const result = parseRateLimitsEvent(data);
    expect(result).toEqual({
      primary: { used_percent: 10, window_minutes: null, reset_at: null },
      secondary: null,
    });
  });

  it("handles invalid used_percent gracefully", () => {
    const data = {
      rate_limits: {
        primary: { used_percent: "not_a_number", window_minutes: 300, reset_at: 1700000000 },
      },
    };
    expect(parseRateLimitsEvent(data)).toBeNull();
  });
});

// ── WS transport integration: callback invocation + event suppression ───

function createMockWsClass(messageSequence: Record<string, unknown>[]) {
  return class {
    private handlers = new Map<string, ((...args: unknown[]) => void)[]>();
    constructor(_url: string, _opts: unknown) {
      queueMicrotask(() => {
        this.emit("upgrade", { headers: {} });
        this.emit("open");
        let step = Promise.resolve();
        for (const msg of messageSequence) {
          step = step.then(
            () =>
              new Promise<void>((resolve) =>
                queueMicrotask(() => {
                  this.emit("message", JSON.stringify(msg));
                  resolve();
                }),
              ),
          );
        }
        step.then(
          () =>
            new Promise<void>((resolve) =>
              queueMicrotask(() => {
                this.emit("close", 1000, Buffer.from(""));
                resolve();
              }),
            ),
        );
      });
    }
    on(event: string, handler: (...args: unknown[]) => void) {
      const list = this.handlers.get(event) ?? [];
      list.push(handler);
      this.handlers.set(event, list);
    }
    private emit(event: string, ...args: unknown[]) {
      for (const handler of this.handlers.get(event) ?? []) {
        handler(...args);
      }
    }
    send = vi.fn();
    close = vi.fn();
  };
}

async function collectSSE(response: Response): Promise<string> {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  const chunks: string[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return chunks.join("");
}

describe("ws-transport rate_limits callback", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("invokes onRateLimits callback and suppresses event from SSE stream", async () => {
    const rateLimitsMsg = {
      type: "codex.rate_limits",
      plan_type: "plus",
      rate_limits: {
        primary: { used_percent: 55.0, window_minutes: 300, reset_at: 1700000000 },
      },
    };

    vi.doMock("ws", () => ({
      default: createMockWsClass([
        { type: "response.created", response: { id: "resp_1" } },
        rateLimitsMsg,
        { type: "response.completed", response: { id: "resp_1" } },
      ]),
    }));

    const { createWebSocketResponse } = await import("@src/proxy/ws-transport.js");

    const captured: ParsedRateLimit[] = [];
    const response = await createWebSocketResponse(
      "wss://example.com/ws",
      { Authorization: "Bearer test" },
      { type: "response.create", model: "test", instructions: "", input: [] },
      undefined,
      undefined,
      (rl) => captured.push(rl),
    );

    const output = await collectSSE(response);

    // Callback was invoked with parsed data
    expect(captured).toHaveLength(1);
    expect(captured[0].primary?.used_percent).toBe(55.0);

    // rate_limits event NOT forwarded to downstream SSE
    expect(output).not.toContain("codex.rate_limits");
    // Normal events still present
    expect(output).toContain("event: response.created");
    expect(output).toContain("event: response.completed");
  });

  it("does not invoke callback when no onRateLimits provided", async () => {
    vi.doMock("ws", () => ({
      default: createMockWsClass([
        { type: "codex.rate_limits", rate_limits: { primary: { used_percent: 10, window_minutes: 300, reset_at: 1 } } },
        { type: "response.completed", response: { id: "resp_1" } },
      ]),
    }));

    const { createWebSocketResponse } = await import("@src/proxy/ws-transport.js");
    const response = await createWebSocketResponse(
      "wss://example.com/ws",
      { Authorization: "Bearer test" },
      { type: "response.create", model: "test", instructions: "", input: [] },
    );

    const output = await collectSSE(response);

    // Without callback, rate_limits event IS forwarded as SSE (no interception)
    expect(output).toContain("codex.rate_limits");
  });
});
