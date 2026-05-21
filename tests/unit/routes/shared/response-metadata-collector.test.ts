import { createResponseMetadataCollector } from "@src/routes/shared/response-metadata-collector.js";
import { describe, expect, it } from "vitest";

describe("createResponseMetadataCollector", () => {
  it("collects unique function call ids from response metadata callbacks", () => {
    const collector = createResponseMetadataCollector();

    collector.onResponseMetadata({ functionCallIds: ["call-a", "call-b"] });
    collector.onResponseMetadata({ functionCallIds: ["call-a", "call-c"] });
    collector.onResponseMetadata({});

    expect(Array.from(collector.responseFunctionCallIds)).toEqual(["call-a", "call-b", "call-c"]);
  });
});
