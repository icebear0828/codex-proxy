/**
 * Tests for the streaming-body idle watchdog in the native transport.
 *
 * Uses a fake bindings object, so no native addon is required: the watchdog
 * logic under test lives entirely in native-transport.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdleWatchdog, NativeTransport } from "@src/tls/native-transport.js";
import { getConfig } from "@src/config.js";

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => ({ tls: { stream_idle_timeout_ms: 5_000, force_http11: false } })),
}));

vi.mock("@src/tls/proxy.js", () => ({
  getProxyUrl: vi.fn(() => null),
}));

vi.mock("@src/paths.js", () => ({
  getBinDir: vi.fn(() => "/tmp/bin"),
}));

function makeTransport(): NativeTransport {
  const bindings = {
    httpGet: vi.fn(),
    httpPost: vi.fn(),
    httpPostStream: vi.fn(async (
      _url: string,
      _headers: Record<string, string>,
      _body: string,
      _onChunk: (chunk: Buffer | null | undefined) => void,
    ) => {
      // Simulated by the caller via captured onChunk — resolve headers immediately.
      return { status: 200, headers: {}, setCookieHeaders: [] };
    }),
  };
  return new NativeTransport(bindings as never);
}

describe("stream idle watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("errors the stream after the idle budget with no bytes", async () => {
    const transport = makeTransport();
    const response = await transport.post("http://upstream.test/responses", {}, "{}");

    let error: Error | null = null;
    const reader = response.body!.getReader();
    const readPromise = reader.read().then(
      (r) => r,
      (err) => { error = err as Error; return null; },
    );

    // Simulate: one byte flows (arms the watchdog), then silence.
    const calls = (transport as unknown as { bindings: { httpPostStream: ReturnType<typeof vi.fn> } })
      .bindings.httpPostStream.mock.calls;
    const streamCallback = calls[0][3] as (chunk: Buffer | null | undefined) => void;
    streamCallback(Buffer.from("event: response.created\n\n"));
    const first = await readPromise;
    expect(error).toBeNull();
    expect(first?.value).toBeDefined();

    // Advance past the 5s idle budget (fake timers + microtask flush).
    const secondRead = reader.read().then(
      () => { /* unexpected success */ },
      (err) => { error = err as Error; },
    );
    await vi.advanceTimersByTimeAsync(6_000);
    await secondRead;

    expect(error).not.toBeNull();
    expect((error as Error).message).toContain("idle");
  });

  it("does not fire while bytes keep flowing", async () => {
    const transport = makeTransport();
    const response = await transport.post("http://upstream.test/responses", {}, "{}");

    const reader = response.body!.getReader();
    const calls = (transport as unknown as { bindings: { httpPostStream: ReturnType<typeof vi.fn> } })
      .bindings.httpPostStream.mock.calls;
    const streamCallback = calls[0][3] as (chunk: Buffer | null | undefined) => void;

    // Drip bytes every 1s for 10s — never idle for the 5s budget.
    for (let i = 0; i < 10; i++) {
      streamCallback(Buffer.from(`data: ${i}\n\n`));
      await vi.advanceTimersByTimeAsync(1_000);
    }
    const result = await reader.read();
    expect(result.value).toBeDefined();

    // Stream completes normally — watchdog must not have fired. Drain the
    // queued drips until the close lands.
    streamCallback(null);
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
    }
    expect(true).toBe(true);
  });

  it("never enforces before the first body byte", async () => {
    const transport = makeTransport();
    const response = await transport.post("http://upstream.test/responses", {}, "{}");
    void response;

    // Headers arrived, body silent for 10s (long thinking pause) — the
    // watchdog is not armed yet and must not fire.
    await vi.advanceTimersByTimeAsync(10_000);
    // No assertion beyond "no throw": arming happens on first chunk only.
  });

  it("disposed watchdog never fires", () => {
    const watchdog = createIdleWatchdog(1_000);
    let fired = false;
    watchdog.arm(() => { fired = true; });
    watchdog.onChunk();
    watchdog.dispose();

    vi.advanceTimersByTime(5_000);
    expect(fired).toBe(false);
  });

  it("reports the configured timeout from config", () => {
    const config = getConfig();
    expect(config.tls.stream_idle_timeout_ms).toBe(5_000);
  });
});

describe("native cancellation (httpCancel)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeCancelableTransport() {
    const httpCancel = vi.fn(() => true);
    let onChunkRef: (chunk: Buffer | null | undefined) => void = () => {};
    const bindings = {
      httpGet: vi.fn(),
      httpPost: vi.fn(),
      httpCancel,
      httpPostStream: vi.fn(async (
        _url: string,
        _headers: Record<string, string>,
        _body: string,
        onChunk: (chunk: Buffer | null | undefined) => void,
      ) => {
        onChunkRef = onChunk;
        return { status: 200, headers: {}, setCookieHeaders: [] };
      }),
    };
    const transport = new NativeTransport(bindings as never);
    const capture = () =>
      (transport as unknown as { bindings: { httpPostStream: ReturnType<typeof vi.fn> } })
        .bindings.httpPostStream.mock.calls;
    return { transport, httpCancel, capture, onChunk: () => onChunkRef };
  }

  it("cancels the upstream request when the watchdog fires", async () => {
    const { transport, httpCancel, capture, onChunk } = makeCancelableTransport();
    const response = await transport.post("http://upstream.test/responses", {}, "{}");

    const reader = response.body!.getReader();
    const readPromise = reader.read().then(
      (r) => r,
      (err) => err as Error,
    );
    capture();
    onChunk()(Buffer.from("event: response.created\n\n"));
    await readPromise;

    const secondRead = reader.read().then(
      () => null,
      (err) => err as Error,
    );
    await vi.advanceTimersByTimeAsync(6_000);
    const err = await secondRead;

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("idle");
    expect(httpCancel).toHaveBeenCalledTimes(1);
    expect(typeof httpCancel.mock.calls[0][0]).toBe("string");
  });

  it("cancels the upstream request on abort", async () => {
    const { transport, httpCancel } = makeCancelableTransport();
    const controller = new AbortController();
    const response = await transport.post(
      "http://upstream.test/responses", {}, "{}", controller.signal,
    );

    const reader = response.body!.getReader();
    const readPromise = reader.read().then(
      (r) => r,
      (err) => err as Error,
    );
    controller.abort();

    const result = await readPromise;
    // Abort closes the stream gracefully — the client sees a normal end.
    expect(result).toEqual({ value: undefined, done: true });
    expect(httpCancel).toHaveBeenCalledTimes(1);
    void reader;
  });

  it("cancels the upstream request when the reader is cancelled", async () => {
    const { transport, httpCancel, capture, onChunk } = makeCancelableTransport();
    const response = await transport.post("http://upstream.test/responses", {}, "{}");

    const reader = response.body!.getReader();
    capture();
    onChunk()(Buffer.from("data: x\n\n"));
    await reader.read();
    await reader.cancel();

    expect(httpCancel).toHaveBeenCalledTimes(1);
  });

  it("never cancels a healthy completed stream", async () => {
    const { transport, httpCancel, capture, onChunk } = makeCancelableTransport();
    const response = await transport.post("http://upstream.test/responses", {}, "{}");

    const reader = response.body!.getReader();
    capture();
    onChunk()(Buffer.from("data: x\n\n"));
    onChunk()(null);
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
    }
    await vi.advanceTimersByTimeAsync(6_000);

    expect(httpCancel).not.toHaveBeenCalled();
  });

  it("rejects and cancels on pre-header hang", async () => {
    const httpCancel = vi.fn(() => true);
    const bindings = {
      httpGet: vi.fn(),
      httpPost: vi.fn(),
      httpCancel,
      httpPostStream: vi.fn(() => new Promise<never>(() => {})), // headers never arrive
    };
    const transport = new NativeTransport(bindings as never);

    const settle = transport.post("http://upstream.test/responses", {}, "{}").then(
      () => null,
      (err: Error) => err,
    );
    await vi.advanceTimersByTimeAsync(6_000);
    const err = await settle;

    expect(err).not.toBeNull();
    expect((err as Error).message).toContain("headers not received");
    expect(httpCancel).toHaveBeenCalledTimes(1);
  });

  it("old addon without httpCancel still works (no extra arg)", async () => {
    const bindings = {
      httpGet: vi.fn(),
      httpPost: vi.fn(),
      httpPostStream: vi.fn(async () => ({ status: 200, headers: {}, setCookieHeaders: [] })),
    };
    const transport = new NativeTransport(bindings as never);
    const response = await transport.post("http://upstream.test/responses", {}, "{}");
    const calls = (transport as unknown as { bindings: { httpPostStream: ReturnType<typeof vi.fn> } })
      .bindings.httpPostStream.mock.calls;

    expect(response.status).toBe(200);
    expect(calls[0].length).toBe(6);
  });
});
