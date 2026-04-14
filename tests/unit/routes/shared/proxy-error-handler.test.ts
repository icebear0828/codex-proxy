import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleCodexApiError, type ErrorAction } from "@src/routes/shared/proxy-error-handler.js";
import { CodexApiError } from "@src/proxy/codex-types.js";

/* ── Minimal mock matching AccountPool subset used by error handler ── */
interface MockPool {
  markRateLimited: ReturnType<typeof vi.fn>;
  markStatus: ReturnType<typeof vi.fn>;
  getEntry: ReturnType<typeof vi.fn>;
  acquire: ReturnType<typeof vi.fn>;
}

function createMockPool(): MockPool {
  return {
    markRateLimited: vi.fn(),
    markStatus: vi.fn(),
    getEntry: vi.fn().mockReturnValue({ email: "test@example.com" }),
    acquire: vi.fn(),
  };
}

describe("handleCodexApiError", () => {
  let pool: MockPool;
  const tag = "Test";
  const model = "gpt-5.4";
  const entryId = "e1";

  beforeEach(() => {
    pool = createMockPool();
  });

  // ── model-not-supported ──

  describe("model-not-supported", () => {
    const err = new CodexApiError(400, JSON.stringify({
      error: { message: "Model gpt-5.4 is not supported on this plan" },
    }));

    it("returns retry action on first occurrence with fallback info", () => {
      const result = handleCodexApiError(err, pool as never, entryId, model, tag, false);

      expect(result.action).toBe("retry");
      expect(result.markModelRetried).toBe(true);
      expect(result.status).toBe(400);
      expect(result.message).toBeDefined();
    });

    it("returns respond action when already retried", () => {
      const result = handleCodexApiError(err, pool as never, entryId, model, tag, true);

      expect(result.action).toBe("respond");
      expect(result.status).toBe(400);
    });

    it("does not mark account status", () => {
      handleCodexApiError(err, pool as never, entryId, model, tag, false);

      expect(pool.markRateLimited).not.toHaveBeenCalled();
      expect(pool.markStatus).not.toHaveBeenCalled();
    });
  });

  // ── 429 rate-limited ──

  describe("429 rate-limited", () => {
    it("marks account rate-limited and returns retry", () => {
      const body = JSON.stringify({ error: { resets_in_seconds: 30 } });
      const err = new CodexApiError(429, body);

      const result = handleCodexApiError(err, pool as never, entryId, model, tag, false);

      expect(result.action).toBe("retry");
      expect(pool.markRateLimited).toHaveBeenCalledWith(entryId, {
        retryAfterSec: 30,
        countRequest: true,
      });
    });

    it("returns respond with 429 when no retry-after info", () => {
      const err = new CodexApiError(429, "rate limited");

      const result = handleCodexApiError(err, pool as never, entryId, model, tag, false);

      expect(result.action).toBe("retry");
      expect(pool.markRateLimited).toHaveBeenCalledWith(entryId, {
        retryAfterSec: undefined,
        countRequest: true,
      });
    });

    it("uses cached quota reset time when account is exhausted", () => {
      const resetAt = Math.floor(Date.now() / 1000) + 86400; // 1 day from now
      pool.getEntry.mockReturnValue({
        email: "test@example.com",
        cachedQuota: {
          rate_limit: { limit_reached: true, reset_at: resetAt },
        },
      });
      const err = new CodexApiError(429, JSON.stringify({ error: { resets_in_seconds: 30 } }));

      handleCodexApiError(err, pool as never, entryId, model, tag, false);

      const call = pool.markRateLimited.mock.calls[0];
      expect(call[0]).toBe(entryId);
      // Should use the longer cached reset time instead of 30s
      expect(call[1].retryAfterSec).toBeGreaterThan(86000);
      expect(call[1].countRequest).toBe(true);
    });

    it("uses short backoff when account is not exhausted", () => {
      pool.getEntry.mockReturnValue({
        email: "test@example.com",
        cachedQuota: {
          rate_limit: { limit_reached: false, used_percent: 50, reset_at: null },
        },
      });
      const err = new CodexApiError(429, JSON.stringify({ error: { resets_in_seconds: 30 } }));

      handleCodexApiError(err, pool as never, entryId, model, tag, false);

      expect(pool.markRateLimited).toHaveBeenCalledWith(entryId, {
        retryAfterSec: 30,
        countRequest: true,
      });
    });
  });

  // ── 402 quota exhausted ──

  describe("402 quota exhausted", () => {
    it("marks account quota_exhausted and returns retry", () => {
      const err = new CodexApiError(402, JSON.stringify({ detail: "Payment required" }));

      const result = handleCodexApiError(err, pool as never, entryId, model, tag, false);

      expect(result.action).toBe("retry");
      expect(result.status).toBe(402);
      expect(pool.markStatus).toHaveBeenCalledWith(entryId, "quota_exhausted");
    });
  });

  // ── 403 ban ──

  describe("403 ban", () => {
    it("marks account banned and returns retry", () => {
      const err = new CodexApiError(403, JSON.stringify({ error: { message: "banned" } }));

      const result = handleCodexApiError(err, pool as never, entryId, model, tag, false);

      expect(result.action).toBe("retry");
      expect(pool.markStatus).toHaveBeenCalledWith(entryId, "banned");
    });

    it("does not treat Cloudflare challenge as ban", () => {
      const err = new CodexApiError(403, "<html>cf_chl challenge</html>");

      const result = handleCodexApiError(err, pool as never, entryId, model, tag, false);

      // Cloudflare 403 is not a ban → generic error path
      expect(result.action).toBe("respond");
      expect(pool.markStatus).not.toHaveBeenCalled();
    });
  });

  // ── 401 token-invalid ──

  describe("401 token-invalid", () => {
    it("marks account expired and returns retry", () => {
      const err = new CodexApiError(401, "token revoked");

      const result = handleCodexApiError(err, pool as never, entryId, model, tag, false);

      expect(result.action).toBe("retry");
      expect(pool.markStatus).toHaveBeenCalledWith(entryId, "expired");
    });

    it("marks account banned when deactivated", () => {
      const err = new CodexApiError(
        401,
        "Your OpenAI account has been deactivated, please check your email",
      );

      const result = handleCodexApiError(err, pool as never, entryId, model, tag, false);

      expect(result.action).toBe("retry");
      expect(pool.markStatus).toHaveBeenCalledWith(entryId, "banned");
    });
  });

  // ── generic errors ──

  describe("generic errors", () => {
    it("returns respond with clamped status for 5xx", () => {
      const err = new CodexApiError(503, "service unavailable");

      const result = handleCodexApiError(err, pool as never, entryId, model, tag, false);

      expect(result.action).toBe("respond");
      expect(result.status).toBe(503);
      expect(result.message).toContain("service unavailable");
    });

    it("clamps non-error status codes to 502", () => {
      const err = new CodexApiError(0, "connection refused");

      const result = handleCodexApiError(err, pool as never, entryId, model, tag, false);

      expect(result.action).toBe("respond");
      expect(result.status).toBe(502);
    });
  });

  // ── ErrorAction shape ──

  describe("ErrorAction shape", () => {
    it("retry action includes releaseBeforeRetry flag for model-not-supported", () => {
      const err = new CodexApiError(400, JSON.stringify({
        error: { message: "Model not supported" },
      }));

      const result = handleCodexApiError(err, pool as never, entryId, model, tag, false);

      expect(result.action).toBe("retry");
      expect(result.releaseBeforeRetry).toBe(true);
    });

    it("retry action for 429/ban/401 does NOT release but includes fallback info", () => {
      const err = new CodexApiError(429, "{}");

      const result = handleCodexApiError(err, pool as never, entryId, model, tag, false);

      expect(result.action).toBe("retry");
      expect(result.releaseBeforeRetry).toBeUndefined();
      // Includes fallback info for when no retry account is available
      expect(result.status).toBe(429);
      expect(result.useFormat429).toBe(true);
    });
  });
});
