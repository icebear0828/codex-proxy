import { CodexApiError } from "@src/proxy/codex-api.js";
import { rethrowNonStreamingCodexApiErrorDuringCollect } from "@src/routes/shared/non-streaming-codex-api-error.js";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("rethrowNonStreamingCodexApiErrorDuringCollect", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs stripped and truncated upstream errors before rethrowing the same object", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const detail = `${"x".repeat(210)} trailing content`;
    const err = new CodexApiError(429, JSON.stringify({ error: { message: detail } }));

    let thrown: unknown;
    try {
      rethrowNonStreamingCodexApiErrorDuringCollect({
        err,
        tag: "openai",
        entryId: "entry-1",
      });
    } catch (caught) {
      thrown = caught;
    }

    expect(thrown).toBe(err);
    expect(warning).toHaveBeenCalledWith(
      `[openai] Account entry-1 | upstream 429 during collect: ${detail.slice(0, 200)}`,
    );
  });
});
