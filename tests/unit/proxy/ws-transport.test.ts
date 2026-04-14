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
  model: "gpt-5.2-codex",
  instructions: "test",
  input: [{ role: "user", content: "hello" }],
};

function lastWs(): MockWs {
  return wsInstances[wsInstances.length - 1] as MockWs;
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
    const response = await createWebSocketResponse("wss://test/ws", { auth: "bearer" }, BASE_REQUEST);
    expect(response.status).toBe(200);

    const ws = lastWs();
    expect(ws.url).toBe("wss://test/ws");
    expect((ws.opts?.headers as Record<string, string>)?.auth).toBe("bearer");
    expect(ws.sentMessages).toHaveLength(1);
    expect(JSON.parse(ws.sentMessages[0])).toEqual(BASE_REQUEST);

    ws.close();
  });

  it("re-encodes WebSocket JSON messages as SSE events", async () => {
    const response = await createWebSocketResponse("wss://test/ws", {}, BASE_REQUEST);
    const ws = lastWs();

    ws.emit("message", JSON.stringify({ type: "response.created", response: { id: "resp_123" } }));
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
    const response = await createWebSocketResponse("wss://test/ws", {}, BASE_REQUEST);
    const ws = lastWs();

    ws.emit("message", JSON.stringify({ type: "response.completed", response: { id: "resp_1" } }));

    const text = await readStream(response);
    expect(text).toContain("response.completed");
  });

  it("closes stream after response.failed", async () => {
    const response = await createWebSocketResponse("wss://test/ws", {}, BASE_REQUEST);
    const ws = lastWs();

    ws.emit("message", JSON.stringify({ type: "response.failed", error: { message: "boom" } }));

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

    await createWebSocketResponse("wss://test/ws", {}, req);
    const ws = lastWs();
    const sent = JSON.parse(ws.sentMessages[0]);
    expect(sent.previous_response_id).toBe("resp_prev_123");
    expect(sent.store).toBeUndefined();
    expect(sent.stream).toBeUndefined();

    ws.close();
  });

  it("preserves message ordering", async () => {
    const response = await createWebSocketResponse("wss://test/ws", {}, BASE_REQUEST);
    const ws = lastWs();

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

    const response = await createWebSocketResponse("wss://test/ws", {}, BASE_REQUEST);
    const ws = lastWs();

    ws.emit("message", JSON.stringify({ type: "response.created", response: { id: "resp_1" } }));
    ws.emit("message", JSON.stringify({ type: "response.output_text.delta", delta: "Hello" }));
    ws.emit("message", JSON.stringify({
      type: "response.completed",
      response: { id: "resp_1", usage: { input_tokens: 10, output_tokens: 5 } },
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
