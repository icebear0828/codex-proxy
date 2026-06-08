import { createResponseMetadataCollector } from "@src/routes/shared/response-metadata-collector.js";
import { describe, expect, it } from "vitest";

describe("createResponseMetadataCollector", () => {
  it("collects unique function call ids from response metadata callbacks", () => {
    const collector = createResponseMetadataCollector();

    collector.onResponseMetadata({ functionCallIds: ["call-a", "call-b"] });
    collector.onResponseMetadata({ functionCallIds: ["call-a", "call-c"] });
    collector.onResponseMetadata({
      reasoningReplayItems: [
        { type: "reasoning", encrypted_content: "encrypted" },
        { type: "function_call", call_id: "call-a", name: "read_file", arguments: "{}" },
      ],
    });
    collector.onResponseMetadata({ invalidReasoningReplay: true });
    collector.onResponseMetadata({});

    expect(Array.from(collector.responseFunctionCallIds)).toEqual(["call-a", "call-b", "call-c"]);
    expect(collector.reasoningReplayItems).toEqual([
      { type: "reasoning", encrypted_content: "encrypted" },
      { type: "function_call", call_id: "call-a", name: "read_file", arguments: "{}" },
    ]);
    expect(collector.invalidReasoningReplay).toBe(true);
  });
});
