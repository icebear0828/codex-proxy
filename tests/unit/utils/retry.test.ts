import { describe, it, expect, vi } from "vitest";
import { CodexApiError } from "@src/proxy/codex-api.js";

// Import after mocks if needed — withRetry uses CodexApiError at runtime
import { withRetry } from "@src/utils/retry.js";

describe("withRetry", () => {
  it("returns result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, { maxRetries: 2, baseDelayMs: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on 5xx errors", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new CodexApiError(500, "Internal"))
      .mockResolvedValue("recovered");

    const result = await withRetry(fn, { maxRetries: 2, baseDelayMs: 1 });
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry on 4xx errors", async () => {
    const fn = vi.fn().mockRejectedValue(new CodexApiError(400, "Bad Request"));

    await expect(withRetry(fn, { maxRetries: 2, baseDelayMs: 1 }))
      .rejects.toThrow("Codex API error (400)");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry on 429 errors", async () => {
    const fn = vi.fn().mockRejectedValue(new CodexApiError(429, "Rate limited"));

    await expect(withRetry(fn, { maxRetries: 2, baseDelayMs: 1 }))
      .rejects.toThrow("Codex API error (429)");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws after maxRetries exhausted", async () => {
    const fn = vi.fn().mockRejectedValue(new CodexApiError(502, "Bad Gateway"));

    await expect(withRetry(fn, { maxRetries: 2, baseDelayMs: 1 }))
      .rejects.toThrow("Codex API error (502)");
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("does not retry non-CodexApiError errors", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("random"));

    await expect(withRetry(fn, { maxRetries: 2, baseDelayMs: 1 }))
      .rejects.toThrow("random");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
