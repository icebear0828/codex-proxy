import type { AccountPool } from "@src/auth/account-pool.js";
import { handleNonStreamingEmptyResponseExhausted } from "@src/routes/shared/non-streaming-empty-response-exhausted.js";
import type { ProxyRequest } from "@src/routes/shared/proxy-handler-types.js";
import { describe, expect, it, vi } from "vitest";

function makePool(options: {
  email?: string | null;
  events?: string[];
} = {}): AccountPool {
  const email = "email" in options ? options.email : "user@example.test";
  const events = options.events;
  return {
    getEntry: vi.fn(() => {
      events?.push("getEntry");
      return { email };
    }),
    release: vi.fn(() => {
      events?.push("release");
    }),
    recordEmptyResponse: vi.fn(() => {
      events?.push("recordEmptyResponse");
    }),
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

describe("handleNonStreamingEmptyResponseExhausted", () => {
  it("releases, logs, records the final empty response, and returns a 502 response plan", () => {
    const events: string[] = [];
    const accountPool = makePool({ events });
    const released = new Set<string>();
    const logWarn = vi.fn(() => {
      events.push("logWarn");
    });

    const result = handleNonStreamingEmptyResponseExhausted({
      accountPool,
      entryId: "entry-1",
      req: makeRequest(),
      tag: "OpenAI",
      attempt: 3,
      maxRetries: 2,
      released,
      logWarn,
    });

    expect(result).toEqual({
      status: 502,
      message: "Codex returned empty responses across all available accounts",
    });
    expect(accountPool.release).toHaveBeenCalledWith("entry-1", undefined);
    expect(released.has("entry-1")).toBe(true);
    expect(logWarn).toHaveBeenCalledWith(
      "[OpenAI] Account entry-1 (user@example.test) | Empty response (attempt 3/3), all retries exhausted",
    );
    expect(accountPool.recordEmptyResponse).toHaveBeenCalledWith("entry-1");
    expect(events).toEqual(["release", "getEntry", "logWarn", "recordEmptyResponse"]);
  });

  it("annotates image generation failures when releasing the exhausted account", () => {
    const accountPool = makePool({ email: null });
    const logWarn = vi.fn();

    handleNonStreamingEmptyResponseExhausted({
      accountPool,
      entryId: "entry-image",
      req: makeRequest({ expectsImageGen: true }),
      tag: "Gemini",
      attempt: 3,
      maxRetries: 2,
      released: new Set<string>(),
      logWarn,
    });

    expect(logWarn).toHaveBeenCalledWith(
      "[Gemini] Account entry-image (?) | Empty response (attempt 3/3), all retries exhausted",
    );
    expect(accountPool.release).toHaveBeenCalledWith("entry-image", {
      input_tokens: 0,
      output_tokens: 0,
      image_request_attempted: true,
      image_request_succeeded: false,
    });
  });

  it("keeps release idempotent while still recording the exhausted empty response", () => {
    const accountPool = makePool();

    handleNonStreamingEmptyResponseExhausted({
      accountPool,
      entryId: "entry-1",
      req: makeRequest(),
      tag: "OpenAI",
      attempt: 3,
      maxRetries: 2,
      released: new Set<string>(["entry-1"]),
      logWarn: vi.fn(),
    });

    expect(accountPool.release).not.toHaveBeenCalled();
    expect(accountPool.recordEmptyResponse).toHaveBeenCalledWith("entry-1");
  });
});
