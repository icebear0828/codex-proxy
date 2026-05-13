import { describe, expect, it } from "vitest";
import { handleNonStreaming } from "@src/routes/shared/non-streaming-handler.js";

describe("non-streaming handler module boundary", () => {
  it("exports the non-streaming collect handler from its own module", () => {
    expect(handleNonStreaming).toBeTypeOf("function");
  });
});
