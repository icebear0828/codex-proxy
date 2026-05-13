import { SessionAffinityMap } from "@src/auth/session-affinity.js";
import { recordNonStreamingSuccessAffinity } from "@src/routes/shared/non-streaming-affinity.js";
import { afterEach, describe, expect, it } from "vitest";

describe("recordNonStreamingSuccessAffinity", () => {
  const affinityMaps: SessionAffinityMap[] = [];

  afterEach(() => {
    for (const affinityMap of affinityMaps) affinityMap.dispose();
    affinityMaps.length = 0;
  });

  it("records response affinity metadata when all required context exists", () => {
    const affinityMap = new SessionAffinityMap();
    affinityMaps.push(affinityMap);

    const recorded = recordNonStreamingSuccessAffinity({
      affinityMap,
      responseId: "resp-ns",
      entryId: "entry-1",
      conversationId: "conversation-1",
      turnState: "turn-1",
      instructions: null,
      inputTokens: 0,
      responseFunctionCallIds: ["call-a", "call-a", "call-b"],
      variantHash: "variant-1",
    });

    expect(recorded).toBe(true);
    expect(affinityMap.lookup("resp-ns")).toBe("entry-1");
    expect(affinityMap.lookupConversationId("resp-ns")).toBe("conversation-1");
    expect(affinityMap.lookupTurnState("resp-ns")).toBe("turn-1");
    expect(affinityMap.lookupInstructions("resp-ns")).toBeNull();
    expect(affinityMap.lookupInputTokens("resp-ns")).toBe(0);
    expect(affinityMap.lookupFunctionCallIds("resp-ns")).toEqual(["call-a", "call-b"]);
    expect(affinityMap.lookupLatestResponseIdByConversationId(
      "conversation-1",
      undefined,
      "variant-1",
    )).toBe("resp-ns");
    expect(affinityMap.lookupLatestResponseIdByConversationId(
      "conversation-1",
      undefined,
      "different-variant",
    )).toBeNull();
  });

  it("does not record when response id, affinity map, or conversation id is missing", () => {
    const affinityMap = new SessionAffinityMap();
    affinityMaps.push(affinityMap);
    const base = {
      affinityMap,
      responseId: "resp-present",
      entryId: "entry-1",
      conversationId: "conversation-1",
      turnState: undefined,
      instructions: undefined,
      inputTokens: 1,
      responseFunctionCallIds: [],
      variantHash: undefined,
    };

    expect(recordNonStreamingSuccessAffinity({ ...base, responseId: null })).toBe(false);
    expect(recordNonStreamingSuccessAffinity({ ...base, affinityMap: undefined })).toBe(false);
    expect(recordNonStreamingSuccessAffinity({ ...base, conversationId: null })).toBe(false);
    expect(recordNonStreamingSuccessAffinity({ ...base, conversationId: undefined })).toBe(false);
    expect(recordNonStreamingSuccessAffinity({ ...base, conversationId: "" })).toBe(false);
    expect(affinityMap.lookup("resp-present")).toBeNull();
  });
});
