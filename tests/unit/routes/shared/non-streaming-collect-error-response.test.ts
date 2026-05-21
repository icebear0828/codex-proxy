import { planNonStreamingCollectErrorResponse } from "@src/routes/shared/non-streaming-collect-error-response.js";
import { describe, expect, it } from "vitest";

describe("planNonStreamingCollectErrorResponse", () => {
  it("uses the HTTP status embedded in Error messages when it is an error status", () => {
    expect(planNonStreamingCollectErrorResponse(
      new Error("upstream failed after HTTP/2 503"),
    )).toEqual({
      status: 503,
      message: "upstream failed after HTTP/2 503",
    });
  });

  it("falls back to 502 when the embedded HTTP status is not an error status", () => {
    expect(planNonStreamingCollectErrorResponse(
      new Error("redirected with HTTP/1.1 302"),
    )).toEqual({
      status: 502,
      message: "redirected with HTTP/1.1 302",
    });
  });

  it("falls back to 502 for regular errors and preserves the message", () => {
    expect(planNonStreamingCollectErrorResponse(
      new Error("plain collect failure"),
    )).toEqual({
      status: 502,
      message: "plain collect failure",
    });
  });

  it("uses the existing unknown-error fallback for non-Error throwables", () => {
    expect(planNonStreamingCollectErrorResponse("boom")).toEqual({
      status: 502,
      message: "Unknown error",
    });
  });
});
