import { logNonStreamingUsage } from "@src/routes/shared/non-streaming-usage-log.js";
import { describe, expect, it, vi } from "vitest";

describe("logNonStreamingUsage", () => {
  it("logs cached, uncached, reasoning, and hit-rate details", () => {
    const log = vi.fn();
    const warn = vi.fn();

    logNonStreamingUsage({
      tag: "OpenAI",
      entryId: "entry-1",
      requestId: "request-123456",
      usage: {
        input_tokens: 42,
        cached_tokens: 10,
        output_tokens: 7,
        reasoning_tokens: 3,
      },
      log,
      warn,
    });

    expect(log).toHaveBeenCalledWith(
      "[OpenAI] Account entry-1 | rid=request- | Usage: in=42 (cached=10 uncached=32) out=7 reasoning=3 | hit=23.8%",
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("preserves the existing zero-cache and zero-input formatting", () => {
    const log = vi.fn();
    const warn = vi.fn();

    logNonStreamingUsage({
      tag: "Gemini",
      entryId: "entry-zero",
      requestId: "rid-zero",
      usage: {
        input_tokens: 0,
        cached_tokens: 0,
        output_tokens: 0,
      },
      log,
      warn,
    });

    expect(log).toHaveBeenCalledWith(
      "[Gemini] Account entry-zero | rid=rid-zero | Usage: in=0 out=0 | hit=n/a",
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns for high input token counts", () => {
    const log = vi.fn();
    const warn = vi.fn();

    logNonStreamingUsage({
      tag: "Anthropic",
      entryId: "entry-high",
      requestId: "rid-high",
      usage: {
        input_tokens: 10_001,
        output_tokens: 2,
      },
      log,
      warn,
    });

    expect(log).toHaveBeenCalledWith(
      "[Anthropic] Account entry-high | rid=rid-high | Usage: in=10001 out=2 | hit=0.0%",
    );
    expect(warn).toHaveBeenCalledWith("[Anthropic] ⚠ High input token count: 10001 tokens");
  });
});
