import type { AccountPool } from "@src/auth/account-pool.js";
import { releaseNonStreamingSuccessAccount } from "@src/routes/shared/non-streaming-success-release.js";
import type { UsageInfo } from "@src/translation/codex-event-extractor.js";
import { describe, expect, it, vi } from "vitest";

function makePool(): AccountPool {
  return {
    release: vi.fn(),
  } as unknown as AccountPool;
}

describe("releaseNonStreamingSuccessAccount", () => {
  it("releases the successful account with collected usage", () => {
    const accountPool = makePool();
    const released = new Set<string>();
    const usage: UsageInfo = { input_tokens: 7, output_tokens: 11 };

    releaseNonStreamingSuccessAccount({
      accountPool,
      entryId: "entry-1",
      usage,
      released,
    });

    expect(accountPool.release).toHaveBeenCalledWith("entry-1", usage);
    expect(released.has("entry-1")).toBe(true);
  });

  it("annotates successful image generation usage before release", () => {
    const accountPool = makePool();
    const usage: UsageInfo = {
      input_tokens: 17,
      output_tokens: 19,
      image_input_tokens: 5,
      image_output_tokens: 3,
    };

    releaseNonStreamingSuccessAccount({
      accountPool,
      entryId: "entry-image",
      usage,
      expectsImageGen: true,
      released: new Set<string>(),
    });

    expect(accountPool.release).toHaveBeenCalledWith("entry-image", {
      input_tokens: 17,
      output_tokens: 19,
      image_input_tokens: 5,
      image_output_tokens: 3,
      image_request_attempted: true,
      image_request_succeeded: true,
    });
    expect(usage.image_request_attempted).toBeUndefined();
    expect(usage.image_request_succeeded).toBeUndefined();
  });

  it("keeps release idempotent through the shared release guard", () => {
    const accountPool = makePool();
    const usage: UsageInfo = { input_tokens: 1, output_tokens: 2 };

    releaseNonStreamingSuccessAccount({
      accountPool,
      entryId: "entry-1",
      usage,
      released: new Set<string>(["entry-1"]),
    });

    expect(accountPool.release).not.toHaveBeenCalled();
  });
});
