import type { AccountPool } from "@src/auth/account-pool.js";
import type { AcquiredAccount } from "@src/auth/types.js";
import {
  applyProxyErrorRetryTransition,
  type ProxyErrorRetryTransitionResult,
} from "@src/routes/shared/proxy-error-retry-transition.js";
import type { ErrorAction } from "@src/routes/shared/proxy-error-handler.js";
import type { AccountPoolSummary } from "@src/routes/shared/proxy-error-response.js";
import { describe, expect, it, vi } from "vitest";

type RespondDecision = Extract<ErrorAction, { action: "respond" }>;
type RetryDecision = Extract<ErrorAction, { action: "retry" }>;

function respondDecision(overrides: Partial<RespondDecision> = {}): RespondDecision {
  return {
    action: "respond",
    status: 422,
    message: "terminal error",
    ...overrides,
  };
}

function retryDecision(overrides: Partial<RetryDecision> = {}): RetryDecision {
  return {
    action: "retry",
    status: 429,
    message: "retryable error",
    ...overrides,
  };
}

function acquired(overrides: Partial<AcquiredAccount> = {}): AcquiredAccount {
  return {
    entryId: "entry-2",
    token: "token-2",
    accountId: "account-2",
    prevSlotMs: 123,
    ...overrides,
  };
}

function summary(overrides: Partial<AccountPoolSummary> = {}): AccountPoolSummary {
  return {
    total: 2,
    active: 0,
    expired: 0,
    quota_exhausted: 0,
    rate_limited: 2,
    refreshing: 0,
    disabled: 0,
    banned: 0,
    ...overrides,
  };
}

function mockPool(options: {
  available?: boolean;
  acquiredAccount?: AcquiredAccount | null;
  summary?: AccountPoolSummary;
} = {}): AccountPool {
  return {
    release: vi.fn(),
    hasAvailableAccounts: vi.fn(() => options.available ?? true),
    getPoolSummary: vi.fn(() => options.summary ?? summary()),
    acquire: vi.fn(() => options.acquiredAccount ?? acquired()),
  } as unknown as AccountPool;
}

describe("applyProxyErrorRetryTransition", () => {
  it("releases the active account and returns a response plan for terminal decisions", () => {
    const accountPool = mockPool();
    const restoreImplicitResumeRequest = vi.fn();
    const released = new Set<string>();

    const result = applyProxyErrorRetryTransition({
      accountPool,
      entryId: "entry-1",
      model: "gpt-5.4",
      triedEntryIds: ["entry-1"],
      tag: "Test",
      decision: respondDecision({ status: 422, message: "bad request" }),
      released,
      restoreImplicitResumeRequest,
      modelRetried: false,
    });

    expect(result).toEqual({
      action: "respond",
      status: 422,
      message: "bad request",
      modelRetried: false,
    });
    expect(accountPool.release).toHaveBeenCalledOnce();
    expect(accountPool.release).toHaveBeenCalledWith("entry-1", undefined);
    expect(restoreImplicitResumeRequest).not.toHaveBeenCalled();
    expect(accountPool.acquire).not.toHaveBeenCalled();
  });

  it("releases model-not-supported accounts before acquiring a fallback and marks the model retried", () => {
    const accountPool = mockPool({ acquiredAccount: acquired({ entryId: "entry-2" }) });
    const restoreImplicitResumeRequest = vi.fn();

    const result = applyProxyErrorRetryTransition({
      accountPool,
      entryId: "entry-1",
      model: "gpt-5.4",
      triedEntryIds: ["entry-1"],
      tag: "Test",
      decision: retryDecision({
        status: 400,
        message: "model not supported",
        releaseBeforeRetry: true,
        markModelRetried: true,
      }),
      released: new Set<string>(),
      restoreImplicitResumeRequest,
      modelRetried: false,
    });

    expect(result.action).toBe("retry");
    const retry = result as Extract<ProxyErrorRetryTransitionResult, { action: "retry" }>;
    expect(retry.entryId).toBe("entry-2");
    expect(retry.prevSlotMs).toBe(123);
    expect(retry.modelRetried).toBe(true);
    expect(accountPool.release).toHaveBeenCalledOnce();
    expect(accountPool.release).toHaveBeenCalledWith("entry-1", undefined);
    expect(restoreImplicitResumeRequest).toHaveBeenCalledOnce();
    expect(accountPool.acquire).toHaveBeenCalledWith({
      model: "gpt-5.4",
      excludeIds: ["entry-1"],
      preferredEntryId: undefined,
    });
  });

  it("does not release rate-limit fallback accounts before acquiring the next account", () => {
    const accountPool = mockPool({ acquiredAccount: acquired({ entryId: "entry-2" }) });
    const restoreImplicitResumeRequest = vi.fn();

    const result = applyProxyErrorRetryTransition({
      accountPool,
      entryId: "entry-1",
      model: "gpt-5.4",
      triedEntryIds: ["entry-1"],
      tag: "Test",
      decision: retryDecision({ status: 429, message: "rate limited", useFormat429: true }),
      released: new Set<string>(),
      restoreImplicitResumeRequest,
      modelRetried: false,
    });

    expect(result.action).toBe("retry");
    expect(accountPool.release).not.toHaveBeenCalled();
    expect(restoreImplicitResumeRequest).toHaveBeenCalledOnce();
    expect(accountPool.acquire).toHaveBeenCalledWith({
      model: "gpt-5.4",
      excludeIds: ["entry-1"],
      preferredEntryId: undefined,
    });
  });

  it("returns fallback response details without rendering when no retry account remains", () => {
    const accountPool = mockPool({
      available: false,
      summary: summary({ rate_limited: 1, expired: 1 }),
    });
    const restoreImplicitResumeRequest = vi.fn();

    const result = applyProxyErrorRetryTransition({
      accountPool,
      entryId: "entry-1",
      model: "gpt-5.4",
      triedEntryIds: ["entry-1"],
      tag: "Test",
      decision: retryDecision({ status: 429, message: "rate limited", useFormat429: true }),
      released: new Set<string>(),
      restoreImplicitResumeRequest,
      modelRetried: false,
    });

    expect(result).toEqual({
      action: "respond",
      status: 429,
      message: "All accounts exhausted (1 rate-limited, 1 expired). rate limited",
      useFormat429: true,
      modelRetried: false,
    });
    expect(accountPool.release).not.toHaveBeenCalled();
    expect(restoreImplicitResumeRequest).toHaveBeenCalledOnce();
    expect(accountPool.acquire).not.toHaveBeenCalled();
  });
});
