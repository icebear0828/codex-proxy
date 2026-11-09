import { describe, it, expect, vi, beforeEach } from "vitest";

const guardConfig = { enabled: true, ttl_seconds: 3600 };
let configThrows = false;

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => {
    if (configThrows) throw new Error("config unavailable");
    return { policy_guard: guardConfig };
  }),
}));

const {
  recordConversationQuarantine,
  peekConversationQuarantine,
  resetConversationQuarantine,
  listConversationQuarantines,
  hashInputItems,
  _resetAllConversationQuarantines,
} = await import("@src/proxy/conversation-quarantine.js");

const CONV = "conv-1";
const T0 = 1_700_000_000_000;

const turn1 = [
  { role: "user", content: "first turn" },
];
const turn2 = [
  { role: "user", content: "first turn" },
  { role: "assistant", content: "reply" },
  { role: "user", content: "second turn" },
];
const edited = [
  { role: "user", content: "first turn EDITED" },
  { role: "assistant", content: "reply" },
];

function record(input: unknown, now = T0): void {
  recordConversationQuarantine({
    conversationId: CONV,
    input,
    code: "cyber_policy",
    message: "blocked",
    now,
  });
}

beforeEach(() => {
  _resetAllConversationQuarantines();
  guardConfig.ttl_seconds = 3600;
  configThrows = false;
});

describe("hashInputItems", () => {
  it("is insensitive to object key order", () => {
    const a = hashInputItems([{ role: "user", content: "x" }]);
    const b = hashInputItems([{ content: "x", role: "user" }]);
    expect(a).toEqual(b);
  });

  it("distinguishes different content", () => {
    expect(hashInputItems(turn1)).not.toEqual(hashInputItems(edited));
  });

  it("returns an empty list for non-array input", () => {
    expect(hashInputItems(undefined)).toEqual([]);
    expect(hashInputItems("not-an-array")).toEqual([]);
  });
});

describe("peekConversationQuarantine", () => {
  it("does not block an unknown conversation", () => {
    expect(peekConversationQuarantine({ conversationId: "other", input: turn1, now: T0 }).blocked)
      .toBe(false);
  });

  it("blocks a resend of the rejected conversation", () => {
    record(turn1);
    const verdict = peekConversationQuarantine({ conversationId: CONV, input: turn1, now: T0 + 1000 });
    expect(verdict.blocked).toBe(true);
    expect(verdict.code).toBe("cyber_policy");
    expect(verdict.message).toBe("blocked");
  });

  it("keeps blocking while the conversation only grows", () => {
    // The offending span is still present, so a later turn must stay refused —
    // this is what stops autonomous "goal"-mode continuations from resending it.
    record(turn1);
    expect(peekConversationQuarantine({ conversationId: CONV, input: turn2, now: T0 + 1000 }).blocked)
      .toBe(true);
  });

  it("releases once the user edits the offending history", () => {
    // The whole point of the prefix check: the user fixed the content, so
    // holding the conversation hostage would be a false positive they cannot
    // clear from the client.
    record(turn1);
    expect(peekConversationQuarantine({ conversationId: CONV, input: edited, now: T0 + 1000 }).blocked)
      .toBe(false);
  });

  it("releases when the history is truncated below the recorded prefix", () => {
    record(turn2);
    expect(peekConversationQuarantine({ conversationId: CONV, input: turn1, now: T0 + 1000 }).blocked)
      .toBe(false);
  });

  it("releases after the TTL elapses", () => {
    record(turn1);
    // Boundary: the entry is still valid at exactly the TTL and released past it.
    expect(peekConversationQuarantine({ conversationId: CONV, input: turn1, now: T0 + 3600_000 }).blocked)
      .toBe(true);
    expect(peekConversationQuarantine({ conversationId: CONV, input: turn1, now: T0 + 3600_001 }).blocked)
      .toBe(false);
  });

  it("honours a custom TTL", () => {
    guardConfig.ttl_seconds = 60;
    record(turn1);
    expect(peekConversationQuarantine({ conversationId: CONV, input: turn1, now: T0 + 59_000 }).blocked)
      .toBe(true);
    expect(peekConversationQuarantine({ conversationId: CONV, input: turn1, now: T0 + 61_000 }).blocked)
      .toBe(false);
  });

  it("falls back to the default TTL when config cannot be read", () => {
    configThrows = true;
    record(turn1);
    expect(peekConversationQuarantine({ conversationId: CONV, input: turn1, now: T0 + 1000 }).blocked)
      .toBe(true);
    expect(peekConversationQuarantine({ conversationId: CONV, input: turn1, now: T0 + 3600_001 }).blocked)
      .toBe(false);
  });

  it("re-anchors the prefix on a second rejection", () => {
    record(turn1);
    // The user edits, gets through, and is rejected again on the new content.
    expect(peekConversationQuarantine({ conversationId: CONV, input: edited, now: T0 + 1000 }).blocked)
      .toBe(false);
    record(edited, T0 + 2000);
    expect(peekConversationQuarantine({ conversationId: CONV, input: edited, now: T0 + 3000 }).blocked)
      .toBe(true);
    // ...and the original history is no longer the anchored one.
    expect(peekConversationQuarantine({ conversationId: CONV, input: turn1, now: T0 + 3000 }).blocked)
      .toBe(false);
  });

  it("ignores an empty conversation id", () => {
    recordConversationQuarantine({
      conversationId: "",
      input: turn1,
      message: "blocked",
      now: T0,
    });
    expect(peekConversationQuarantine({ conversationId: "", input: turn1, now: T0 }).blocked)
      .toBe(false);
  });
});

describe("resetConversationQuarantine", () => {
  it("releases the conversation", () => {
    record(turn1);
    resetConversationQuarantine(CONV);
    expect(peekConversationQuarantine({ conversationId: CONV, input: turn1, now: T0 + 1000 }).blocked)
      .toBe(false);
  });
});

describe("listConversationQuarantines", () => {
  it("reports active entries and drops expired ones", () => {
    record(turn1);
    expect(listConversationQuarantines(T0 + 1000)).toHaveLength(1);
    expect(listConversationQuarantines(T0 + 3600_001)).toHaveLength(0);
  });
});
