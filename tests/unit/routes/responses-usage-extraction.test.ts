/**
 * Regression test for the /v1/responses route's usage extraction.
 *
 * Without the fix, cached_tokens (nested in `input_tokens_details` per the
 * OpenAI Responses API contract) would be dropped between the upstream
 * SSE event and the account-pool bookkeeping, so the dashboard always
 * reported `total_cached_tokens: 0` even when the upstream reported a
 * non-zero cache hit.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => ({})),
}));

vi.mock("@src/paths.js", () => ({
  getDataDir: vi.fn(() => "/tmp/test-data"),
  getConfigDir: vi.fn(() => "/tmp/test-config"),
}));

import { extractResponseUsage, extractImageGenUsage } from "@src/routes/responses.js";

describe("/v1/responses extractResponseUsage", () => {
  it("extracts cached_tokens from input_tokens_details", () => {
    const usage = {
      input_tokens: 1948,
      output_tokens: 12,
      input_tokens_details: { cached_tokens: 1280 },
    };
    expect(extractResponseUsage(usage)).toEqual({
      input_tokens: 1948,
      output_tokens: 12,
      cached_tokens: 1280,
    });
  });

  it("omits cached_tokens when upstream did not report a cache hit", () => {
    const usage = {
      input_tokens: 100,
      output_tokens: 20,
      input_tokens_details: { cached_tokens: 0 },
    };
    const result = extractResponseUsage(usage);
    expect(result.cached_tokens).toBe(0);
  });

  it("omits cached_tokens entirely when input_tokens_details is missing", () => {
    expect(extractResponseUsage({ input_tokens: 100, output_tokens: 20 })).toEqual({
      input_tokens: 100,
      output_tokens: 20,
    });
  });

  it("ignores non-numeric cached_tokens values", () => {
    expect(extractResponseUsage({
      input_tokens: 100,
      output_tokens: 20,
      input_tokens_details: { cached_tokens: "1000" },
    })).toEqual({
      input_tokens: 100,
      output_tokens: 20,
    });
  });

  it("defaults missing input_tokens / output_tokens to 0", () => {
    expect(extractResponseUsage({ input_tokens_details: { cached_tokens: 50 } })).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cached_tokens: 50,
    });
  });
});

describe("/v1/responses extractImageGenUsage", () => {
  it("extracts image_input_tokens / image_output_tokens from tool_usage.image_gen", () => {
    expect(extractImageGenUsage({
      tool_usage: {
        image_gen: {
          input_tokens: 31,
          output_tokens: 196,
          total_tokens: 227,
        },
      },
    })).toEqual({ image_input_tokens: 31, image_output_tokens: 196 });
  });

  it("returns undefined when tool_usage is missing", () => {
    expect(extractImageGenUsage({})).toBeUndefined();
    expect(extractImageGenUsage({ usage: { input_tokens: 100 } })).toBeUndefined();
  });

  it("returns undefined when image_gen sub-block is missing", () => {
    expect(extractImageGenUsage({ tool_usage: { web_search: { num_requests: 0 } } })).toBeUndefined();
  });

  it("returns undefined when both image counts are zero (no image generated)", () => {
    expect(extractImageGenUsage({
      tool_usage: { image_gen: { input_tokens: 0, output_tokens: 0 } },
    })).toBeUndefined();
  });

  it("treats non-numeric token fields as zero (and so omits the entry when both are zero)", () => {
    expect(extractImageGenUsage({
      tool_usage: { image_gen: { input_tokens: "31", output_tokens: null } },
    })).toBeUndefined();
  });

  it("returns partial counts when only one side is non-zero", () => {
    expect(extractImageGenUsage({
      tool_usage: { image_gen: { input_tokens: 0, output_tokens: 196 } },
    })).toEqual({ image_input_tokens: 0, image_output_tokens: 196 });
  });
});
