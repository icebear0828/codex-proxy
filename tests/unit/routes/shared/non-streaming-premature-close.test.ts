import type { AccountPool } from "@src/auth/account-pool.js";
import { handleNonStreamingPrematureClose } from "@src/routes/shared/non-streaming-premature-close.js";
import type { ProxyRequest } from "@src/routes/shared/proxy-handler-types.js";
import { UpstreamPrematureCloseError } from "@src/translation/codex-event-extractor.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@src/logs/stream-close-event.js", () => ({
  recordStreamCloseEvent: vi.fn(),
}));

const streamCloseEventModule = await import("@src/logs/stream-close-event.js");
const recordStreamCloseEventMock = vi.mocked(streamCloseEventModule.recordStreamCloseEvent);

function makePool(options: {
  email?: string | null;
} = {}): AccountPool {
  const email = "email" in options ? options.email : "user@example.test";
  return {
    getEntry: vi.fn(() => ({ email })),
    release: vi.fn(),
  } as unknown as AccountPool;
}

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

describe("handleNonStreamingPrematureClose", () => {
  beforeEach(() => {
    recordStreamCloseEventMock.mockReset();
  });

  it("records the premature close event, releases the account, and returns a 504 response plan", () => {
    const accountPool = makePool();
    const released = new Set<string>();
    const logWarn = vi.fn();
    const err = new UpstreamPrematureCloseError("resp-pc", true, 1920);
    const request = makeRequest();

    const result = handleNonStreamingPrematureClose({
      accountPool,
      entryId: "entry-1",
      err,
      req: request,
      tag: "OpenAI",
      requestId: "rid-123456",
      released,
      variantHash: "variant-1",
      logWarn,
    });

    expect(result).toEqual({
      status: 504,
      message: err.message,
    });
    expect(logWarn).toHaveBeenCalledWith(
      "[OpenAI] Account entry-1 (user@example.test) | upstream premature close (hadReasoning=true events=1920) — failing fast, not retrying",
    );
    expect(recordStreamCloseEventMock).toHaveBeenCalledWith({
      kind: "upstream-premature",
      requestId: "rid-123456",
      tag: "OpenAI",
      model: "client-model",
      accountEntryId: "entry-1",
      variantHash: "variant-1",
      responseId: "resp-pc",
      eventCount: 1920,
      hadReasoning: true,
      detail: err.message,
    });
    expect(accountPool.release).toHaveBeenCalledWith("entry-1", undefined);
    expect(released.has("entry-1")).toBe(true);
  });

  it("annotates image generation failures when releasing a premature-close request", () => {
    const accountPool = makePool({ email: null });
    const logWarn = vi.fn();
    const err = new UpstreamPrematureCloseError(null, false, 0);

    handleNonStreamingPrematureClose({
      accountPool,
      entryId: "entry-image",
      err,
      req: makeRequest({ expectsImageGen: true }),
      tag: "Gemini",
      requestId: "rid-image",
      released: new Set<string>(),
      logWarn,
    });

    expect(logWarn).toHaveBeenCalledWith(
      "[Gemini] Account entry-image (?) | upstream premature close (hadReasoning=false events=0) — failing fast, not retrying",
    );
    expect(accountPool.release).toHaveBeenCalledWith("entry-image", {
      input_tokens: 0,
      output_tokens: 0,
      image_request_attempted: true,
      image_request_succeeded: false,
    });
  });

  it("keeps the release idempotent when the account was already released", () => {
    const accountPool = makePool();
    const released = new Set<string>(["entry-1"]);

    handleNonStreamingPrematureClose({
      accountPool,
      entryId: "entry-1",
      err: new UpstreamPrematureCloseError("resp-pc", false, 2),
      req: makeRequest(),
      tag: "OpenAI",
      requestId: "rid-123456",
      released,
      logWarn: vi.fn(),
    });

    expect(accountPool.release).not.toHaveBeenCalled();
    expect(recordStreamCloseEventMock).toHaveBeenCalledOnce();
  });
});
