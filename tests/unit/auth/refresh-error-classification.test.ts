import { describe, expect, it } from "vitest";
import { isPermanentRefreshError } from "@src/auth/refresh-scheduler.js";

describe("refresh error classification", () => {
  it("treats upstream refresh_token_invalidated as permanent", () => {
    expect(isPermanentRefreshError("Token refresh failed (401): refresh_token_invalidated")).toBe(true);
  });
});
