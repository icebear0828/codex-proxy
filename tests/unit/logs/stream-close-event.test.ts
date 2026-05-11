/**
 * Tests for recordStreamCloseEvent — the structured persistence layer for
 * premature stream close / client abort events. Verifies both downstream
 * sinks (Errors-tab error log + in-memory audit log) receive a record with
 * the caller-supplied diagnostic context.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";

let tmpDataDir = "";

const mockConfig = {
  observability: { local_error_log: true, max_log_bytes: 10 * 1024 * 1024 },
  client: { app_version: "0.0.0-test" },
};

vi.mock("@src/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@src/paths.js")>();
  return { ...actual, getDataDir: () => tmpDataDir };
});

vi.mock("@src/config.js", () => ({ getConfig: () => mockConfig }));

beforeEach(() => {
  tmpDataDir = mkdtempSync(resolve(tmpdir(), "stream-close-evt-"));
  // Re-enable the file writer under Vitest — see error-log.ts for why
  // it's suppressed by default.
  process.env.VITEST_FORCE_APPEND_ERROR_LOG = "1";
  vi.resetModules();
});

afterEach(() => {
  if (existsSync(tmpDataDir)) rmSync(tmpDataDir, { recursive: true, force: true });
  delete process.env.VITEST_FORCE_APPEND_ERROR_LOG;
  vi.clearAllMocks();
});

async function importAll() {
  const { recordStreamCloseEvent } = await import("@src/logs/stream-close-event.js");
  const { logStore } = await import("@src/logs/store.js");
  logStore.clear();
  logStore.setState({ enabled: true, paused: false });
  return { recordStreamCloseEvent, logStore };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
}

function readErrorLogLines(): Array<Record<string, unknown>> {
  const path = resolve(tmpDataDir, "error-log.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("recordStreamCloseEvent", () => {
  it("writes an Errors-tab entry and an audit log entry for upstream-premature", async () => {
    const { recordStreamCloseEvent, logStore } = await importAll();
    recordStreamCloseEvent({
      kind: "upstream-premature",
      requestId: "rid-abc",
      tag: "Responses",
      model: "gpt-5.5",
      accountEntryId: "e-42",
      responseId: "resp_pc",
      variantHash: "vh-deadbeef",
      eventCount: 1920,
      hadReasoning: true,
      detail: "WebSocket closed before terminal event: code=1006",
      closeCode: 1006,
    });

    const errEntries = readErrorLogLines();
    expect(errEntries).toHaveLength(1);
    const err = errEntries[0];
    expect(err.source).toBe("server");
    const errBody = err.error as Record<string, unknown>;
    expect(errBody.name).toBe("StreamUpstreamPrematureClose");
    expect(errBody.message).toContain("Upstream stream closed before terminal event");
    expect(errBody.message).toContain("code=1006");
    const ctx = err.context as Record<string, unknown>;
    expect(ctx).toMatchObject({
      kind: "upstream-premature",
      requestId: "rid-abc",
      tag: "Responses",
      model: "gpt-5.5",
      accountEntryId: "e-42",
      responseId: "resp_pc",
      variantHash: "vh-deadbeef",
      eventCount: 1920,
      hadReasoning: true,
      closeCode: 1006,
    });

    await flushMicrotasks();
    const audit = logStore.list({ limit: 50 });
    expect(audit.records).toHaveLength(1);
    const log = audit.records[0];
    expect(log.requestId).toBe("rid-abc");
    expect(log.direction).toBe("egress");
    expect(log.model).toBe("gpt-5.5");
    expect(log.provider).toBe("codex");
    expect(log.stream).toBe(true);
    expect(log.error).toContain("Upstream stream closed before terminal event");
    const req = log.request as Record<string, unknown>;
    expect(req).toMatchObject({
      kind: "upstream-premature",
      accountEntryId: "e-42",
      responseId: "resp_pc",
      eventCount: 1920,
      hadReasoning: true,
      closeCode: 1006,
      variantHash: "vh-deadbeef",
    });
  });

  it("emits a client-abort entry with the correct name and message", async () => {
    const { recordStreamCloseEvent, logStore } = await importAll();
    recordStreamCloseEvent({
      kind: "client-abort",
      requestId: "rid-cli",
      tag: "Responses",
      model: "gpt-5.5",
      accountEntryId: "e-7",
      variantHash: "vh-cafef00d",
    });

    const errEntries = readErrorLogLines();
    expect(errEntries).toHaveLength(1);
    const errBody = errEntries[0].error as Record<string, unknown>;
    expect(errBody.name).toBe("StreamClientAbort");
    expect(errBody.message).toBe("Client aborted stream");

    await flushMicrotasks();
    const audit = logStore.list({ limit: 50 });
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0].error).toBe("Client aborted stream");
    const req = audit.records[0].request as Record<string, unknown>;
    expect(req.kind).toBe("client-abort");
    expect(req).not.toHaveProperty("eventCount");
    expect(req).not.toHaveProperty("hadReasoning");
  });

  it("propagates client-write-failed diagnostics (chunks/bytes/lastEvent)", async () => {
    const { recordStreamCloseEvent, logStore } = await importAll();
    recordStreamCloseEvent({
      kind: "client-write-failed",
      requestId: "rid-wf",
      tag: "Anthropic",
      model: "claude-opus-4-7",
      writtenChunks: 12,
      writtenBytes: 3456,
      lastSentEvent: "response.output_text.delta",
      sentTerminal: false,
      detail: "socket hang up",
    });

    const errEntries = readErrorLogLines();
    expect(errEntries).toHaveLength(1);
    const errBody = errEntries[0].error as Record<string, unknown>;
    expect(errBody.name).toBe("StreamClientWriteFailed");
    expect(errBody.message).toContain("socket hang up");
    const ctx = errEntries[0].context as Record<string, unknown>;
    expect(ctx).toMatchObject({
      writtenChunks: 12,
      writtenBytes: 3456,
      lastSentEvent: "response.output_text.delta",
      sentTerminal: false,
    });

    await flushMicrotasks();
    const audit = logStore.list({ limit: 50 });
    const req = audit.records[0].request as Record<string, unknown>;
    expect(req.writtenChunks).toBe(12);
    expect(req.writtenBytes).toBe(3456);
  });

  it("populates status from a numeric upstreamStatus", async () => {
    const { recordStreamCloseEvent, logStore } = await importAll();
    recordStreamCloseEvent({
      kind: "upstream-error",
      requestId: "rid-err",
      model: "gpt-5.5",
      upstreamStatus: 502,
      detail: "Bad gateway",
    });

    await flushMicrotasks();
    const audit = logStore.list({ limit: 50 });
    expect(audit.records[0].status).toBe(502);
  });

  it("falls back to a synthetic requestId when none is provided", async () => {
    const { recordStreamCloseEvent, logStore } = await importAll();
    recordStreamCloseEvent({ kind: "upstream-premature", detail: "early eof" });

    await flushMicrotasks();
    const audit = logStore.list({ limit: 50 });
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0].requestId).toBe("stream-close");

    const errEntries = readErrorLogLines();
    expect(errEntries).toHaveLength(1);
    const ctx = errEntries[0].context as Record<string, unknown>;
    expect(ctx).not.toHaveProperty("requestId");
  });
});
