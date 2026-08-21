import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueueLogEntry: vi.fn(),
  updateLogEntry: vi.fn(() => false),
  getConfig: vi.fn(() => ({ logs: { llm_only: true } })),
}));

vi.mock("@src/logs/entry.js", () => ({
  enqueueLogEntry: mocks.enqueueLogEntry,
  updateLogEntry: mocks.updateLogEntry,
}));

vi.mock("@src/config.js", () => ({
  getConfig: mocks.getConfig,
}));

import { isKnownLlmPath, logCapture } from "@src/middleware/log-capture.js";

function createContext(path = "/v1/messages", extraGet: Record<string, unknown> = {}) {
  const headers = new Map<string, string>();
  return {
    get: vi.fn((key: string) => {
      if (key === "requestId") return "req-123";
      return extraGet[key];
    }),
    header: vi.fn((key: string, value: string) => {
      headers.set(key, value);
    }),
    req: { method: "POST", path },
    res: { status: 201 },
  } as unknown as Parameters<typeof logCapture>[0];
}

describe("logCapture middleware", () => {
  beforeEach(() => {
    mocks.enqueueLogEntry.mockClear();
    mocks.updateLogEntry.mockClear();
    mocks.updateLogEntry.mockReturnValue(false);
    mocks.getConfig.mockReturnValue({ logs: { llm_only: true } });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-15T00:00:00.000Z"));
  });

  it("recognizes known LLM paths", () => {
    expect(isKnownLlmPath("/v1/chat/completions")).toBe(true);
    expect(isKnownLlmPath("/v1/messages")).toBe(true);
    expect(isKnownLlmPath("/v1beta/models/gemini-2.5-pro:generateContent")).toBe(true);
    expect(isKnownLlmPath("/admin/settings")).toBe(false);
  });

  it("enqueues an ingress log for LLM paths when record does not exist", async () => {
    const c = createContext("/v1/messages");
    const next = vi.fn(async () => {
      vi.setSystemTime(new Date("2026-04-15T00:00:00.025Z"));
    });

    await logCapture(c, next as never);

    expect(next).toHaveBeenCalledTimes(1);
    expect(mocks.updateLogEntry).toHaveBeenCalledWith("req-123", expect.objectContaining({
      status: 201,
      latencyMs: 25,
    }));
    expect(mocks.enqueueLogEntry).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "req-123",
      direction: "ingress",
      method: "POST",
      path: "/v1/messages",
      status: 201,
      latencyMs: 25,
    }));
  });

  it("does not enqueue duplicate log if updateLogEntry returns true", async () => {
    mocks.updateLogEntry.mockReturnValue(true);
    const c = createContext("/v1/messages");
    const next = vi.fn(async () => {
      vi.setSystemTime(new Date("2026-04-15T00:00:00.025Z"));
    });

    await logCapture(c, next as never);

    expect(mocks.updateLogEntry).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueLogEntry).not.toHaveBeenCalled();
  });

  it("skips internal admin requests even in all-logs mode", async () => {
    mocks.getConfig.mockReturnValue({ logs: { llm_only: false } });
    const c = createContext("/admin/logs");

    await logCapture(c, vi.fn(async () => {}) as never);

    expect(mocks.updateLogEntry).not.toHaveBeenCalled();
    expect(mocks.enqueueLogEntry).not.toHaveBeenCalled();
  });

  it("skips health and static assets", async () => {
    mocks.getConfig.mockReturnValue({ logs: { llm_only: false } });
    const c = createContext("/health");

    await logCapture(c, vi.fn(async () => {}) as never);

    expect(mocks.updateLogEntry).not.toHaveBeenCalled();
    expect(mocks.enqueueLogEntry).not.toHaveBeenCalled();
  });

  it("captures non-admin requests when llm-only mode is disabled", async () => {
    mocks.getConfig.mockReturnValue({ logs: { llm_only: false } });
    const c = createContext("/v2/custom/generate");

    await logCapture(c, vi.fn(async () => {}) as never);

    expect(mocks.enqueueLogEntry).toHaveBeenCalledOnce();
  });
});
