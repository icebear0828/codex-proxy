import { describe, it, expect } from "vitest";
import { CodexApiError } from "@src/proxy/codex-types.js";
import {
  extractRetryAfterSec,
  isBanError,
  isQuotaExhaustedError,
  isTokenInvalidError,
  isModelNotSupportedError,
} from "@src/proxy/error-classification.js";

describe("extractRetryAfterSec", () => {
  it("extracts resets_in_seconds from 429 body", () => {
    const body = JSON.stringify({ error: { resets_in_seconds: 30 } });
    expect(extractRetryAfterSec(body)).toBe(30);
  });

  it("computes seconds from resets_at timestamp", () => {
    const futureTs = Date.now() / 1000 + 60;
    const body = JSON.stringify({ error: { resets_at: futureTs } });
    const result = extractRetryAfterSec(body);
    expect(result).toBeGreaterThan(50);
    expect(result).toBeLessThanOrEqual(60);
  });

  it("returns undefined for past resets_at", () => {
    const pastTs = Date.now() / 1000 - 10;
    const body = JSON.stringify({ error: { resets_at: pastTs } });
    expect(extractRetryAfterSec(body)).toBeUndefined();
  });

  it("returns undefined for missing error field", () => {
    expect(extractRetryAfterSec(JSON.stringify({ detail: "nope" }))).toBeUndefined();
  });

  it("returns undefined for invalid JSON", () => {
    expect(extractRetryAfterSec("not json")).toBeUndefined();
  });

  it("returns undefined for zero resets_in_seconds", () => {
    const body = JSON.stringify({ error: { resets_in_seconds: 0 } });
    expect(extractRetryAfterSec(body)).toBeUndefined();
  });
});

describe("isQuotaExhaustedError", () => {
  it("returns true for 402", () => {
    const err = new CodexApiError(402, '{"detail": "Payment required"}');
    expect(isQuotaExhaustedError(err)).toBe(true);
  });

  it("returns false for non-402", () => {
    const err = new CodexApiError(429, '{"error": "rate limited"}');
    expect(isQuotaExhaustedError(err)).toBe(false);
  });

  it("returns false for non-CodexApiError", () => {
    expect(isQuotaExhaustedError(new Error("402"))).toBe(false);
    expect(isQuotaExhaustedError(null)).toBe(false);
  });
});

describe("isBanError", () => {
  it("returns true for non-CF 403", () => {
    const err = new CodexApiError(403, '{"detail": "Your account has been flagged"}');
    expect(isBanError(err)).toBe(true);
  });

  it("returns false for CF challenge 403 (cf_chl)", () => {
    const err = new CodexApiError(403, '<!DOCTYPE html><html><body>cf_chl_managed</body></html>');
    expect(isBanError(err)).toBe(false);
  });

  it("returns false for CF challenge 403 (HTML page)", () => {
    const err = new CodexApiError(403, '<!DOCTYPE html><html><head></head></html>');
    expect(isBanError(err)).toBe(false);
  });

  it("returns false for non-403 status", () => {
    const err = new CodexApiError(429, '{"error": "rate limited"}');
    expect(isBanError(err)).toBe(false);
  });

  it("returns false for non-CodexApiError", () => {
    expect(isBanError(new Error("random"))).toBe(false);
    expect(isBanError("string")).toBe(false);
    expect(isBanError(null)).toBe(false);
  });
});

describe("isTokenInvalidError", () => {
  it("returns true for 401", () => {
    const err = new CodexApiError(401, '{"detail": "unauthorized"}');
    expect(isTokenInvalidError(err)).toBe(true);
  });

  it("returns false for non-401", () => {
    const err = new CodexApiError(403, '{"detail": "forbidden"}');
    expect(isTokenInvalidError(err)).toBe(false);
  });

  it("returns false for non-CodexApiError", () => {
    expect(isTokenInvalidError(new Error("401"))).toBe(false);
  });
});

describe("isModelNotSupportedError", () => {
  it("detects 'model not supported' in message", () => {
    const err = new CodexApiError(400, '{"detail": "Model gpt-5.4 not supported for free plan"}');
    expect(isModelNotSupportedError(err)).toBe(true);
  });

  it("detects 'model not_available' in message", () => {
    const err = new CodexApiError(400, '{"detail": "Model gpt-5.4 not_available"}');
    expect(isModelNotSupportedError(err)).toBe(true);
  });

  it("returns false for 429 (rate limit)", () => {
    const err = new CodexApiError(429, '{"detail": "Model not supported"}');
    expect(isModelNotSupportedError(err)).toBe(false);
  });

  it("returns false for 5xx", () => {
    const err = new CodexApiError(500, '{"detail": "Model not supported"}');
    expect(isModelNotSupportedError(err)).toBe(false);
  });

  it("returns false when message lacks 'model'", () => {
    const err = new CodexApiError(400, '{"detail": "Feature not supported"}');
    expect(isModelNotSupportedError(err)).toBe(false);
  });
});
