import { describe, expect, it } from "vitest";
import {
  ReasoningReplayCache,
  REASONING_REPLAY_CACHE_TTL_MS,
  containsInvalidEncryptedContentSignal,
} from "@src/proxy/reasoning-replay-cache.js";
import { IMPLICIT_RESUME_MAX_AGE_MS } from "@src/routes/shared/proxy-session-helpers.js";

describe("ReasoningReplayCache", () => {
  it("keeps the default TTL aligned with the implicit resume window", () => {
    let now = 1_000;
    const cache = new ReasoningReplayCache({ nowMs: () => now });

    expect(REASONING_REPLAY_CACHE_TTL_MS).toBe(IMPLICIT_RESUME_MAX_AGE_MS);
    expect(cache.record({
      responseId: "resp_implicit",
      entryId: "entry_a",
      conversationId: "conversation",
      variantHash: "variant",
      items: [{ type: "reasoning", id: "rs_implicit", summary: [], encrypted_content: "encrypted" }],
    })).toBe(1);

    now += IMPLICIT_RESUME_MAX_AGE_MS + 1;
    expect(cache.lookup({
      responseId: "resp_implicit",
      entryId: "entry_a",
      conversationId: "conversation",
      variantHash: "variant",
    })).toEqual([]);
  });

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
          summary: [],
          encrypted_content: "encrypted",
          signature: "unsupported",
          content: [
            { type: "reasoning_text", text: "kept" },
            { type: "reasoning_text", text: 123 },
          ],
        },
        { type: "reasoning", encrypted_content: "" },
        { type: "reasoning", id: "rs_missing_summary", encrypted_content: "missing_summary" },
        { type: "reasoning", summary: [], encrypted_content: "missing_id" },
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
        summary: [],
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
      items: [{ type: "reasoning", id: "rs_old", summary: [], encrypted_content: "old" }],
    });
    cache.record({
      responseId: "resp_new",
      entryId: "entry_a",
      conversationId: "conversation",
      variantHash: "variant",
      items: [{ type: "reasoning", id: "rs_new", summary: [], encrypted_content: "new" }],
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

  it("drops oversized entries and evicts oldest entries by total byte budget", () => {
    const tooLarge = new ReasoningReplayCache({
      maxEntryBytes: 200,
      nowMs: () => 1_000,
    });

    expect(tooLarge.record({
      responseId: "resp_huge",
      entryId: "entry_a",
      conversationId: "conversation",
      variantHash: "variant",
      items: [{
        type: "reasoning",
        id: "rs_huge",
        summary: [],
        encrypted_content: "x".repeat(1_000),
      }],
    })).toBe(0);
    expect(tooLarge.size).toBe(0);

    const budgeted = new ReasoningReplayCache({
      maxTotalBytes: 700,
      nowMs: () => 1_000,
    });

    budgeted.record({
      responseId: "resp_old",
      entryId: "entry_a",
      conversationId: "conversation",
      variantHash: "variant",
      items: [{ type: "reasoning", id: "rs_old", summary: [], encrypted_content: "o".repeat(300) }],
    });
    budgeted.record({
      responseId: "resp_new",
      entryId: "entry_a",
      conversationId: "conversation",
      variantHash: "variant",
      items: [{ type: "reasoning", id: "rs_new", summary: [], encrypted_content: "n".repeat(300) }],
    });

    expect(budgeted.lookup({
      responseId: "resp_old",
      entryId: "entry_a",
      conversationId: "conversation",
      variantHash: "variant",
    })).toEqual([]);
    expect(budgeted.lookup({
      responseId: "resp_new",
      entryId: "entry_a",
      conversationId: "conversation",
      variantHash: "variant",
    })).toHaveLength(1);
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
