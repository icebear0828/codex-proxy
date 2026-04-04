import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for ws-transport close behavior.
 * Verifies that the stream closes cleanly after receiving a terminal event.
 */

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

describe("ws-transport close behavior", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("closes stream cleanly after terminal event", async () => {
    vi.doMock("ws", () => ({
      default: createMockWsClass([
        { type: "response.created", response: { id: "resp_1" } },
        { type: "response.completed", response: { id: "resp_1" } },
      ]),
    }));

    const { createWebSocketResponse } = await import("../ws-transport.js");
    const response = await createWebSocketResponse(
      "wss://example.com/ws",
      { Authorization: "Bearer test" },
      { type: "response.create", model: "test", instructions: "", input: [] },
    );

    const output = await collectSSE(response);
    expect(output).toContain("event: response.created");
    expect(output).toContain("event: response.completed");
    expect(output).not.toContain("premature_close");
  });

  it("closes stream when WS closes without terminal event", async () => {
    vi.doMock("ws", () => ({
      default: createMockWsClass([
        { type: "response.created", response: { id: "resp_1" } },
        // no terminal event — WS closes directly
      ]),
    }));

    const { createWebSocketResponse } = await import("../ws-transport.js");
    const response = await createWebSocketResponse(
      "wss://example.com/ws",
      { Authorization: "Bearer test" },
      { type: "response.create", model: "test", instructions: "", input: [] },
    );

    // Stream should still close (not hang) even without terminal event
    const output = await collectSSE(response);
    expect(output).toContain("event: response.created");
  });
});
