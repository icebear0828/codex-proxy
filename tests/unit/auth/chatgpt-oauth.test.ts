import { describe, it, expect } from "vitest";
import { validateManualToken, validateTokenStructure } from "@src/auth/chatgpt-oauth.js";
import { createValidJwt, createExpiredJwt, createJwt } from "@helpers/jwt.js";

describe("validateManualToken", () => {
  it("validates a valid token", () => {
    const token = createValidJwt();
    const result = validateManualToken(token);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("rejects empty string", () => {
    const result = validateManualToken("");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("empty");
  });

  it("rejects expired token", () => {
    const token = createExpiredJwt();
    const result = validateManualToken(token);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("expired");
  });

  it("rejects token without accountId", () => {
    // Valid JWT with exp but no auth claim
    const token = createJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const result = validateManualToken(token);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("chatgpt_account_id");
  });

  it("rejects invalid JWT format", () => {
    const result = validateManualToken("not-a-jwt");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Invalid JWT");
  });

  it("structural validation accepts an unexpired token without accountId", () => {
    const token = createJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    expect(validateTokenStructure(token)).toEqual({ valid: true });
    expect(validateManualToken(token)).toMatchObject({
      valid: false,
      error: expect.stringContaining("chatgpt_account_id"),
    });
  });

  it("structural validation rejects a token without numeric exp", () => {
    expect(validateTokenStructure(createJwt({}))).toMatchObject({
      valid: false,
      error: expect.stringContaining("exp"),
    });
  });
});
