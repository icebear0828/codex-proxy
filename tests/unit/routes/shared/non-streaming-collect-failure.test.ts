import type { AccountPool } from "@src/auth/account-pool.js";
import { handleNonStreamingCollectFailure } from "@src/routes/shared/non-streaming-collect-failure.js";
import type { ProxyRequest } from "@src/routes/shared/proxy-handler-types.js";
import { describe, expect, it, vi } from "vitest";

function makePool(): AccountPool {
  return {
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

describe("handleNonStreamingCollectFailure", () => {
  it("releases the account and returns the planned upstream error status", () => {
    const accountPool = makePool();
    const released = new Set<string>();

    const result = handleNonStreamingCollectFailure({
      accountPool,
      entryId: "entry-1",
      req: makeRequest(),
      collectErr: new Error("collect failed after HTTP/2 503"),
      released,
    });

    expect(result).toEqual({
      status: 503,
      message: "collect failed after HTTP/2 503",
    });
    expect(accountPool.release).toHaveBeenCalledWith("entry-1", undefined);
    expect(released.has("entry-1")).toBe(true);
  });

  it("annotates image generation failures when no usage was collected", () => {
    const accountPool = makePool();

    const result = handleNonStreamingCollectFailure({
      accountPool,
      entryId: "entry-image",
      req: makeRequest({ expectsImageGen: true }),
      collectErr: "boom",
      released: new Set<string>(),
    });

    expect(result).toEqual({
      status: 502,
      message: "Unknown error",
    });
    expect(accountPool.release).toHaveBeenCalledWith("entry-image", {
      input_tokens: 0,
      output_tokens: 0,
      image_request_attempted: true,
      image_request_succeeded: false,
    });
  });

  it("keeps release idempotent while still returning the response plan", () => {
    const accountPool = makePool();

    const result = handleNonStreamingCollectFailure({
      accountPool,
      entryId: "entry-1",
      req: makeRequest(),
      collectErr: new Error("plain collect failure"),
      released: new Set<string>(["entry-1"]),
    });

    expect(result).toEqual({
      status: 502,
      message: "plain collect failure",
    });
    expect(accountPool.release).not.toHaveBeenCalled();
  });
});
