import { describe, it, expect } from "vitest";
import {
  streamResponse,
  HEARTBEAT_INTERVAL_MS,
  type StreamWriter,
} from "@src/routes/shared/response-processor.js";
import type { FormatAdapter } from "@src/routes/shared/proxy-handler-types.js";
import type { UpstreamAdapter } from "@src/proxy/upstream-adapter.js";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const HEARTBEAT = ": ping\n\n";

function makeWriter(): { writer: StreamWriter; chunks: string[] } {
  const chunks: string[] = [];
  const writer: StreamWriter = {
    write: (chunk: string) => {
      chunks.push(chunk);
      return Promise.resolve();
    },
    onAbort: () => {},
  };
  return { writer, chunks };
}

/** Minimal adapter whose stream yields `first`, stays silent for `gapMs`,
 *  then yields `second` and completes. */
function makeAdapter(gapMs: number): FormatAdapter {
  return {
    tag: "test",
    streamTranslator: async function* () {
      yield "data: first\n\n";
      if (gapMs > 0) await delay(gapMs);
      yield "data: second\n\n";
    },
  } as unknown as FormatAdapter;
}

function runStream(opts: { gapMs: number; heartbeatMs?: number }) {
  const { writer, chunks } = makeWriter();
  const promise = streamResponse({
    writer,
    api: {} as unknown as UpstreamAdapter,
    response: new Response(),
    model: "test-model",
    adapter: makeAdapter(opts.gapMs),
    onUsage: () => {},
    ...(opts.heartbeatMs !== undefined ? { heartbeatMs: opts.heartbeatMs } : {}),
  });
  return { promise, chunks };
}

describe("streamResponse heartbeat", () => {
  it("emits SSE heartbeat comments during a silent upstream gap", async () => {
    const { promise, chunks } = runStream({ gapMs: 80, heartbeatMs: 20 });
    await promise;

    const heartbeats = chunks.filter((c) => c === HEARTBEAT);
    expect(heartbeats.length).toBeGreaterThanOrEqual(1);

    // Real chunks are still forwarded, in order, and a heartbeat lands between
    // them (inside the gap).
    const firstIdx = chunks.indexOf("data: first\n\n");
    const secondIdx = chunks.indexOf("data: second\n\n");
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect(secondIdx).toBeGreaterThan(firstIdx);
    const hbBetween = chunks
      .slice(firstIdx + 1, secondIdx)
      .some((c) => c === HEARTBEAT);
    expect(hbBetween).toBe(true);
  });

  it("does not emit heartbeats when the stream finishes before the interval", async () => {
    const { promise, chunks } = runStream({ gapMs: 0, heartbeatMs: 50 });
    await promise;
    expect(chunks.filter((c) => c === HEARTBEAT)).toHaveLength(0);
  });

  it("stops the heartbeat timer once the stream completes", async () => {
    const { promise, chunks } = runStream({ gapMs: 40, heartbeatMs: 15 });
    await promise;
    const countAfterDone = chunks.filter((c) => c === HEARTBEAT).length;
    // Wait well beyond the interval; no further heartbeats must appear.
    await delay(60);
    expect(chunks.filter((c) => c === HEARTBEAT).length).toBe(countAfterDone);
  });

  it("disables heartbeats when heartbeatMs is 0", async () => {
    const { promise, chunks } = runStream({ gapMs: 60, heartbeatMs: 0 });
    await promise;
    expect(chunks.filter((c) => c === HEARTBEAT)).toHaveLength(0);
  });

  it("exposes a default interval below common middlebox idle timeouts", () => {
    expect(HEARTBEAT_INTERVAL_MS).toBeLessThanOrEqual(25_000);
    expect(HEARTBEAT_INTERVAL_MS).toBeGreaterThan(0);
  });
});
