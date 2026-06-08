import { describe, expect, it } from "vitest";
import {
  ReasoningReplayCache,
  containsInvalidEncryptedContentSignal,
} from "@src/proxy/reasoning-replay-cache.js";

describe("ReasoningReplayCache", () => {
  it("captures only protocol-valid replay artifacts and isolates by account", () => {
    let now = 1_000;
    const cache = new ReasoningReplayCache({
      ttlMs: 10_000,
      maxEntries: 10,
      nowMs: () => now,
    });

    cache.record({
      responseId: "resp_1",
      entryId: "entry_a",
      conversationId: "conversation",
      variantHash: "variant",
      items: [
        {
          type: "reasoning",
          id: "rs_1",
          status: "completed",
          encrypted_content: "encrypted",
          signature: "unsupported",
          content: [
            { type: "reasoning_text", text: "kept" },
            { type: "reasoning_text", text: 123 },
          ],
        },
        { type: "reasoning", encrypted_content: "" },
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "read_file",
          arguments: "{}",
          extra: "unsupported",
        },
        { type: "function_call", call_id: "call_bad", name: "missing arguments" },
      ],
    });

    expect(cache.lookup({
      responseId: "resp_1",
      entryId: "entry_a",
      conversationId: "conversation",
      variantHash: "variant",
    })).toEqual([
      {
        type: "reasoning",
        id: "rs_1",
        status: "completed",
        encrypted_content: "encrypted",
        content: [{ type: "reasoning_text", text: "kept" }],
      },
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "read_file",
        arguments: "{}",
      },
    ]);
    expect(cache.lookup({
      responseId: "resp_1",
      entryId: "entry_b",
      conversationId: "conversation",
      variantHash: "variant",
    })).toEqual([]);

    now += 10_001;
    expect(cache.lookup({
      responseId: "resp_1",
      entryId: "entry_a",
      conversationId: "conversation",
      variantHash: "variant",
    })).toEqual([]);
  });

  it("evicts oldest entries by size and affected entries by identity", () => {
    const cache = new ReasoningReplayCache({
      ttlMs: 10_000,
      maxEntries: 1,
      nowMs: () => 1_000,
    });

    cache.record({
      responseId: "resp_old",
      entryId: "entry_a",
      conversationId: "conversation",
      variantHash: "variant",
      items: [{ type: "reasoning", encrypted_content: "old" }],
    });
    cache.record({
      responseId: "resp_new",
      entryId: "entry_a",
      conversationId: "conversation",
      variantHash: "variant",
      items: [{ type: "reasoning", encrypted_content: "new" }],
    });

    expect(cache.lookup({
      responseId: "resp_old",
      entryId: "entry_a",
      conversationId: "conversation",
      variantHash: "variant",
    })).toEqual([]);
    expect(cache.lookup({
      responseId: "resp_new",
      entryId: "entry_a",
      conversationId: "conversation",
      variantHash: "variant",
    })).toHaveLength(1);

    expect(cache.evictByIdentity({
      entryId: "entry_a",
      conversationId: "conversation",
      variantHash: "variant",
    })).toBe(1);
    expect(cache.lookup({
      responseId: "resp_new",
      entryId: "entry_a",
      conversationId: "conversation",
      variantHash: "variant",
    })).toEqual([]);
  });
});

describe("containsInvalidEncryptedContentSignal", () => {
  it("detects structured invalid encrypted reasoning content errors", () => {
    expect(containsInvalidEncryptedContentSignal({
      error: {
        code: "invalid_encrypted_content",
        message: "The reasoning encrypted_content is no longer valid.",
      },
    })).toBe(true);
    expect(containsInvalidEncryptedContentSignal(
      new Error("Codex API error: invalid encrypted content"),
    )).toBe(true);
    expect(containsInvalidEncryptedContentSignal({
      error: { code: "rate_limit_exceeded" },
    })).toBe(false);
  });
});
