/**
 * Tests for WebSocket transport — SSE re-encoding, stream lifecycle, abort.
 */

import { EventEmitter } from "node:events";

const wsInstances = vi.hoisted(() => [] as EventEmitter[]);

vi.mock("ws", () => {
  const { EventEmitter: EE } = require("node:events") as typeof import("node:events");

  class MockWebSocket extends EE {
    readyState = 0;
    sentMessages: string[] = [];
    url: string;
    opts: Record<string, unknown> | undefined;

    constructor(url: string, opts?: Record<string, unknown>) {
      super();
      this.url = url;
      this.opts = opts;
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

interface MockWs extends EventEmitter {
  url: string;
  opts?: Record<string, unknown>;
  sentMessages: string[];
  readyState: number;
  close(code?: number, reason?: string): void;
}

const BASE_REQUEST: WsCreateRequest = {
  type: "response.create",
  model: "gpt-5.3-codex",
  instructions: "test",
  input: [{ role: "user", content: "hello" }],
};

function lastWs(): MockWs {
  return wsInstances[wsInstances.length - 1] as MockWs;
}

/**
 * Wait until the dynamic import inside `createWebSocketResponse` finishes,
 * the MockWebSocket constructor has registered an instance, and the `open`
 * microtask has fired (so `ws.send(request)` has run).
 */
async function waitForOpen(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (wsInstances.length > 0) {
      const ws = wsInstances[wsInstances.length - 1] as MockWs;
      if (ws.readyState === 1 && ws.sentMessages.length > 0) return;
    }
    await new Promise<void>((r) => setTimeout(r, 0));
  }
  throw new Error("WebSocket did not open within timeout");
}

/**
 * Start a connect, wait for `open` to fire, and return the unresolved
 * promise + the MockWs so tests can drive the message sequence.
 *
 * `createWebSocketResponse` no longer resolves on `open` — it waits for the
 * first non-internal frame so it can detect early upstream errors and reject
 * with a `CodexApiError` instead of streaming the error to the client.
 */
async function startConnect(
  req: WsCreateRequest = BASE_REQUEST,
  headers: Record<string, string> = {},
): Promise<{ promise: Promise<Response>; ws: MockWs }> {
  const promise = createWebSocketResponse("wss://test/ws", headers, req);
  // Swallow the rejection if the test never awaits `promise` (e.g. it
  // expects the promise to reject). We re-throw on any awaiter via the
  // returned reference, so this only suppresses unhandled-rejection noise.
  promise.catch(() => { /* test-controlled */ });
  await waitForOpen();
  return { promise, ws: lastWs() };
}

/** Drive a normal connect: emit `response.created` to unblock resolve. */
async function connect(
  req: WsCreateRequest = BASE_REQUEST,
  headers: Record<string, string> = {},
): Promise<{ response: Response; ws: MockWs }> {
  const { promise, ws } = await startConnect(req, headers);
  ws.emit("message", JSON.stringify({ type: "response.created", response: { id: "resp_init" } }));
  const response = await promise;
  return { response, ws };
}

/** Helper: read entire stream to string */
async function readStream(response: Response): Promise<string> {
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

describe("createWebSocketResponse", () => {
  beforeEach(() => {
    wsInstances.length = 0;
  });

  it("connects and sends the request message", async () => {
    const { promise, ws } = await startConnect(BASE_REQUEST, { auth: "bearer" });

    expect(ws.url).toBe("wss://test/ws");
    expect((ws.opts?.headers as Record<string, string>)?.auth).toBe("bearer");
    expect(ws.sentMessages).toHaveLength(1);
    expect(JSON.parse(ws.sentMessages[0])).toEqual(BASE_REQUEST);

    // Unblock resolve and verify the Response is HTTP 200.
    ws.emit("message", JSON.stringify({ type: "response.created", response: { id: "resp_1" } }));
    const response = await promise;
    expect(response.status).toBe(200);

    ws.close();
  });

  it("re-encodes WebSocket JSON messages as SSE events", async () => {
    const { promise, ws } = await startConnect();

    ws.emit("message", JSON.stringify({ type: "response.created", response: { id: "resp_123" } }));
    const response = await promise;

    ws.emit("message", JSON.stringify({ type: "response.output_text.delta", delta: "Hello" }));
    ws.emit("message", JSON.stringify({
      type: "response.completed",
      response: { id: "resp_123", usage: { input_tokens: 10, output_tokens: 5 } },
    }));

    const text = await readStream(response);

    // Verify SSE format
    expect(text).toContain("event: response.created\n");
    expect(text).toContain("event: response.output_text.delta\n");
    expect(text).toContain("event: response.completed\n");

    // Verify data lines are valid JSON
    const blocks = text.split("\n\n").filter(b => b.trim());
    expect(blocks).toHaveLength(3);

    for (const block of blocks) {
      const dataLine = block.split("\n").find(l => l.startsWith("data: "));
      expect(dataLine).toBeDefined();
      const json = JSON.parse(dataLine!.slice(6));
      expect(json.type).toBeTruthy();
    }
  });

  it("closes stream after response.completed", async () => {
    const { promise, ws } = await startConnect();

    ws.emit("message", JSON.stringify({ type: "response.completed", response: { id: "resp_1" } }));

    const response = await promise;
    const text = await readStream(response);
    expect(text).toContain("response.completed");
  });

  it("closes stream after response.failed without rotatable error code", async () => {
    const { promise, ws } = await startConnect();

    // No `error.code` / `error.type` → classifier returns null → resolves
    // and streams the failure to the client (current pass-through behavior).
    ws.emit("message", JSON.stringify({ type: "response.failed", error: { message: "boom" } }));

    const response = await promise;
    const text = await readStream(response);
    expect(text).toContain("response.failed");
  });

  it("respects abort signal (pre-connect)", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      createWebSocketResponse("wss://test/ws", {}, BASE_REQUEST, controller.signal),
    ).rejects.toThrow("Aborted");
  });

  it("passes previous_response_id without store/stream fields", async () => {
    const req: WsCreateRequest = {
      ...BASE_REQUEST,
      previous_response_id: "resp_prev_123",
    };

    const { ws } = await startConnect(req);
    const sent = JSON.parse(ws.sentMessages[0]);
    expect(sent.previous_response_id).toBe("resp_prev_123");
    expect(sent.store).toBeUndefined();
    expect(sent.stream).toBeUndefined();

    ws.close();
  });

  it("preserves message ordering", async () => {
    const { promise, ws } = await startConnect();

    ws.emit("message", JSON.stringify({ type: "response.created", response: { id: "resp_1" } }));
    const response = await promise;

    for (let i = 0; i < 5; i++) {
      ws.emit("message", JSON.stringify({ type: "response.output_text.delta", delta: `chunk${i}` }));
    }
    ws.emit("message", JSON.stringify({ type: "response.completed", response: { id: "resp_1" } }));

    const text = await readStream(response);

    for (let i = 0; i < 5; i++) {
      expect(text).toContain(`chunk${i}`);
    }
    const idx0 = text.indexOf("chunk0");
    const idx4 = text.indexOf("chunk4");
    const idxCompleted = text.indexOf("response.completed");
    expect(idx0).toBeLessThan(idx4);
    expect(idx4).toBeLessThan(idxCompleted);
  });

  it("SSE output is compatible with parseStream", async () => {
    // Import CodexApi to verify parseStream works with WS-generated SSE
    const { CodexApi } = await import("@src/proxy/codex-api.js");

    const { response, ws } = await connect();

    ws.emit("message", JSON.stringify({ type: "response.output_text.delta", delta: "Hello" }));
    ws.emit("message", JSON.stringify({
      type: "response.completed",
      response: { id: "resp_init", usage: { input_tokens: 10, output_tokens: 5 } },
    }));

    // parseStream should work identically on WS-generated SSE
    const api = new CodexApi("test", null);
    const events = [];
    for await (const evt of api.parseStream(response)) {
      events.push(evt);
    }

    expect(events).toHaveLength(3);
    expect(events[0].event).toBe("response.created");
    expect(events[1].event).toBe("response.output_text.delta");
    expect((events[1].data as Record<string, unknown>).delta).toBe("Hello");
    expect(events[2].event).toBe("response.completed");
  });
});
