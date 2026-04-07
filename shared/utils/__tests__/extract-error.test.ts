import { describe, it, expect } from "vitest";
import { extractErrorMessage } from "../extract-error";

describe("extractErrorMessage", () => {
  it("extracts from flat admin format: { error: 'string' }", () => {
    expect(extractErrorMessage({ error: "Invalid current API key" }, "fallback"))
      .toBe("Invalid current API key");
  });

  it("extracts from nested OpenAI format: { error: { message: '...' } }", () => {
    expect(extractErrorMessage(
      { error: { message: "Config validation failed", type: "server_error", param: null, code: "internal_error" } },
      "fallback",
    )).toBe("Config validation failed");
  });

  it("returns fallback for null body", () => {
    expect(extractErrorMessage(null, "HTTP 500")).toBe("HTTP 500");
  });

  it("returns fallback for empty object", () => {
    expect(extractErrorMessage({}, "HTTP 500")).toBe("HTTP 500");
  });

  it("returns fallback for body with non-string, non-object error", () => {
    expect(extractErrorMessage({ error: 42 }, "HTTP 500")).toBe("HTTP 500");
  });

  it("returns fallback when nested error.message is not a string", () => {
    expect(extractErrorMessage({ error: { message: 123 } }, "HTTP 500")).toBe("HTTP 500");
  });
});
