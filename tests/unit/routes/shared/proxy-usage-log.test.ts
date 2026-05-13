import { logProxyUsage } from "@src/routes/shared/proxy-usage-log.js";
import { describe, expect, it, vi } from "vitest";

describe("logProxyUsage", () => {
  it("logs streaming image token details when enabled", () => {
    const log = vi.fn();
    const warn = vi.fn();

    logProxyUsage({
      tag: "Responses",
      entryId: "entry-stream",
      requestId: "request-stream",
      usage: {
        input_tokens: 42,
        cached_tokens: 10,
        output_tokens: 7,
        reasoning_tokens: 3,
        image_input_tokens: 4,
        image_output_tokens: 5,
      },
      includeImageTokens: true,
      log,
      warn,
    });

    expect(log).toHaveBeenCalledWith(
      "[Responses] Account entry-stream | rid=request- | Usage: in=42 (cached=10 uncached=32) out=7 reasoning=3 image=4/5 | hit=23.8%",
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps image token details hidden by default", () => {
    const log = vi.fn();
    const warn = vi.fn();

    logProxyUsage({
      tag: "Responses",
      entryId: "entry-nonstream",
      requestId: "request-nonstream",
      usage: {
        input_tokens: 42,
        output_tokens: 7,
        image_input_tokens: 4,
        image_output_tokens: 5,
      },
      log,
      warn,
    });

    expect(log).toHaveBeenCalledWith(
      "[Responses] Account entry-nonstream | rid=request- | Usage: in=42 out=7 | hit=0.0%",
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("preserves streaming high-input warning reasoning detail when enabled", () => {
    const log = vi.fn();
    const warn = vi.fn();

    logProxyUsage({
      tag: "Responses",
      entryId: "entry-high",
      requestId: "request-high",
      usage: {
        input_tokens: 10_001,
        output_tokens: 2,
        reasoning_tokens: 9,
      },
      includeReasoningInHighInputWarning: true,
      log,
      warn,
    });

    expect(log).toHaveBeenCalledWith(
      "[Responses] Account entry-high | rid=request- | Usage: in=10001 out=2 reasoning=9 | hit=0.0%",
    );
    expect(warn).toHaveBeenCalledWith(
      "[Responses] ⚠ High input token count: 10001 tokens (reasoning=9)",
    );
  });
});
