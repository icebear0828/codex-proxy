import { describe, expect, it } from "vitest";
import { isPermanentRefreshError } from "@src/auth/refresh-scheduler.js";

describe("refresh error classification", () => {
  it("treats upstream refresh_token_invalidated as permanent", () => {
    expect(isPermanentRefreshError("Token refresh failed (401): refresh_token_invalidated")).toBe(true);
    expect(isPermanentRefreshError("REFRESH_TOKEN_INVALIDATED")).toBe(true);
  });

  it("treats standard oauth permanent errors as permanent", () => {
    expect(isPermanentRefreshError("invalid_grant")).toBe(true);
    expect(isPermanentRefreshError("account has been deactivated")).toBe(true);
  });

  it("does not treat transient or network errors as permanent", () => {
    expect(isPermanentRefreshError("connect ETIMEDOUT 104.18.2.161:443")).toBe(false);
    expect(isPermanentRefreshError("Internal Server Error (500)")).toBe(false);
    expect(isPermanentRefreshError("Too Many Requests (429)")).toBe(false);
  });
});
