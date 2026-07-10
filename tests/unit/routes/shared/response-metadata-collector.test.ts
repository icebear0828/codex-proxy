import { createResponseMetadataCollector } from "@src/routes/shared/response-metadata-collector.js";
import { describe, expect, it } from "vitest";

describe("createResponseMetadataCollector", () => {
  it("collects unique function call ids from response metadata callbacks", () => {
    const collector = createResponseMetadataCollector();

    collector.onResponseMetadata({ functionCallIds: ["call-a", "call-b"] });
    collector.onResponseMetadata({ functionCallIds: ["call-a", "call-c"] });
    collector.onResponseMetadata({
      reasoningReplayItems: [
        { type: "reasoning", id: "rs_replay", summary: [], encrypted_content: "encrypted" },
        { type: "function_call", call_id: "call-a", name: "read_file", arguments: "{}" },
      ],
    });
    collector.onResponseMetadata({ invalidReasoningReplay: true });
    collector.onResponseMetadata({});

    expect(Array.from(collector.responseFunctionCallIds)).toEqual(["call-a", "call-b", "call-c"]);
    expect(collector.reasoningReplayItems).toEqual([
      { type: "reasoning", id: "rs_replay", summary: [], encrypted_content: "encrypted" },
      { type: "function_call", call_id: "call-a", name: "read_file", arguments: "{}" },
    ]);
    expect(collector.invalidReasoningReplay).toBe(true);
  });

  it("latches prematureClose and terminalFailure flags independently", () => {
    const collector = createResponseMetadataCollector();
    expect(collector.prematureClose).toBe(false);
    expect(collector.terminalFailure).toBe(false);

    collector.onResponseMetadata({ terminalFailure: true });
    expect(collector.terminalFailure).toBe(true);
    expect(collector.prematureClose).toBe(false);

    collector.onResponseMetadata({ prematureClose: true });
    collector.onResponseMetadata({});
    expect(collector.prematureClose).toBe(true);
    expect(collector.terminalFailure).toBe(true);
  });
});
