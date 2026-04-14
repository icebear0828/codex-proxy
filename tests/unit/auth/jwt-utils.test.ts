import { describe, it, expect } from "vitest";
import {
  decodeJwtPayload,
  extractChatGptAccountId,
  extractUserProfile,
  isTokenExpired,
} from "@src/auth/jwt-utils.js";
import { createJwt, createValidJwt, createExpiredJwt } from "@helpers/jwt.js";

describe("decodeJwtPayload", () => {
  it("decodes a valid JWT payload", () => {
    const token = createJwt({ foo: "bar", num: 42 });
    const payload = decodeJwtPayload(token);
    expect(payload).not.toBeNull();
    expect(payload!.foo).toBe("bar");
    expect(payload!.num).toBe(42);
  });

  it("returns null for token with fewer than 2 parts", () => {
    expect(decodeJwtPayload("single-part")).toBeNull();
  });

  it("returns null for invalid base64 payload", () => {
    expect(decodeJwtPayload("header.!!!invalid!!!.sig")).toBeNull();
  });

  it("returns null for non-object payload", () => {
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const payload = Buffer.from('"just a string"').toString("base64url");
    expect(decodeJwtPayload(`${header}.${payload}.`)).toBeNull();
  });
});

describe("extractChatGptAccountId", () => {
  it("extracts accountId from auth claim", () => {
    const token = createJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct-test-123",
      },
    });
    expect(extractChatGptAccountId(token)).toBe("acct-test-123");
  });

  it("returns null when auth claim is missing", () => {
    const token = createJwt({ foo: "bar" });
    expect(extractChatGptAccountId(token)).toBeNull();
  });

  it("returns null when chatgpt_account_id is not a string", () => {
    const token = createJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: 12345,
      },
    });
    expect(extractChatGptAccountId(token)).toBeNull();
  });
});

describe("extractUserProfile", () => {
  it("extracts email from profile claim", () => {
    const token = createJwt({
      "https://api.openai.com/profile": {
        email: "user@example.com",
      },
    });
    const profile = extractUserProfile(token);
    expect(profile).not.toBeNull();
    expect(profile!.email).toBe("user@example.com");
  });

  it("extracts plan_type from auth claim (preferred)", () => {
    const token = createJwt({
      "https://api.openai.com/auth": {
        chatgpt_plan_type: "plus",
      },
    });
    const profile = extractUserProfile(token);
    expect(profile).not.toBeNull();
    expect(profile!.chatgpt_plan_type).toBe("plus");
  });

  it("falls back to profile claim for plan_type", () => {
    const token = createJwt({
      "https://api.openai.com/profile": {
        chatgpt_plan_type: "free",
      },
    });
    const profile = extractUserProfile(token);
    expect(profile).not.toBeNull();
    expect(profile!.chatgpt_plan_type).toBe("free");
  });

  it("returns null when no profile/auth claims exist", () => {
    const token = createJwt({ foo: "bar" });
    expect(extractUserProfile(token)).toBeNull();
  });
});

describe("isTokenExpired", () => {
  it("returns false for non-expired token", () => {
    const token = createValidJwt({ expInSeconds: 3600 });
    expect(isTokenExpired(token)).toBe(false);
  });

  it("returns true for expired token", () => {
    const token = createExpiredJwt();
    expect(isTokenExpired(token)).toBe(true);
  });

  it("considers margin in expiry check", () => {
    // Token expires in 100 seconds, margin is 200 seconds
    const token = createJwt({ exp: Math.floor(Date.now() / 1000) + 100 });
    expect(isTokenExpired(token, 200)).toBe(true);
    expect(isTokenExpired(token, 50)).toBe(false);
  });

  it("returns true for non-numeric exp", () => {
    const token = createJwt({ exp: "not-a-number" });
    expect(isTokenExpired(token)).toBe(true);
  });

  it("returns true for invalid token", () => {
    expect(isTokenExpired("not-a-jwt")).toBe(true);
  });
});
