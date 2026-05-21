import type { AccountPool } from "@src/auth/account-pool.js";
import type { AcquiredAccount } from "@src/auth/types.js";
import type { ProxyPool } from "@src/proxy/proxy-pool.js";
import {
  prepareProxyFallbackAccountRetry,
  type ProxyFallbackAccountRetryResult,
} from "@src/routes/shared/proxy-fallback-account-retry.js";
import type { ErrorAction } from "@src/routes/shared/proxy-error-handler.js";
import type { AccountPoolSummary } from "@src/routes/shared/proxy-error-response.js";
import { describe, expect, it, vi } from "vitest";

type RetryDecision = Extract<ErrorAction, { action: "retry" }>;

function retryDecision(overrides: Partial<RetryDecision> = {}): RetryDecision {
  return {
    action: "retry",
    status: 429,
    message: "rate limited",
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

function acquired(overrides: Partial<AcquiredAccount> = {}): AcquiredAccount {
  return {
    entryId: "entry-2",
    token: "token-2",
    accountId: "account-2",
    prevSlotMs: 123,
    ...overrides,
  };
}

function mockPool(options: {
  available: boolean;
  acquiredAccount?: AcquiredAccount | null;
  summary?: AccountPoolSummary;
}): AccountPool {
  return {
    hasAvailableAccounts: vi.fn(() => options.available),
    getPoolSummary: vi.fn(() => options.summary ?? summary()),
    acquire: vi.fn(() => options.acquiredAccount ?? null),
  } as unknown as AccountPool;
}

function mockProxyPool(): ProxyPool {
  return {
    resolveProxyUrl: vi.fn(() => "http://proxy.local:7890"),
  } as unknown as ProxyPool;
}

describe("prepareProxyFallbackAccountRetry", () => {
  it("acquires a retry account, builds its API, and preserves prev slot timing", () => {
    const nextAccount = acquired();
    const accountPool = mockPool({ available: true, acquiredAccount: nextAccount });
    const proxyPool = mockProxyPool();
    const log = vi.fn();

    const result = prepareProxyFallbackAccountRetry({
      accountPool,
      model: "gpt-5.4",
      triedEntryIds: ["entry-1"],
      tag: "Test",
      decision: retryDecision(),
      cookieJar: undefined,
      proxyPool,
      log,
    });

    expect(result.action).toBe("retry");
    const retry = result as Extract<ProxyFallbackAccountRetryResult, { action: "retry" }>;
    expect(retry.entryId).toBe("entry-2");
    expect(retry.prevSlotMs).toBe(123);
    expect(retry.api).toBeDefined();
    expect(accountPool.hasAvailableAccounts).toHaveBeenCalledWith(["entry-1"]);
    expect(accountPool.acquire).toHaveBeenCalledWith({
      model: "gpt-5.4",
      excludeIds: ["entry-1"],
      preferredEntryId: undefined,
    });
    expect(proxyPool.resolveProxyUrl).toHaveBeenCalledWith("entry-2");
    expect(log).toHaveBeenCalledWith("[Test] Fallback \u2192 account entry-2");
  });

  it("returns an exhaustion response plan when no accounts are available", () => {
    const accountPool = mockPool({
      available: false,
      summary: summary({ rate_limited: 1, expired: 1 }),
    });

    const result = prepareProxyFallbackAccountRetry({
      accountPool,
      model: "gpt-5.4",
      triedEntryIds: ["entry-1"],
      tag: "Test",
      decision: retryDecision({ useFormat429: true }),
    });

    expect(result).toEqual({
      action: "respond",
      status: 429,
      message: "All accounts exhausted (1 rate-limited, 1 expired). rate limited",
      useFormat429: true,
    });
    expect(accountPool.getPoolSummary).toHaveBeenCalled();
    expect(accountPool.acquire).not.toHaveBeenCalled();
  });

  it("falls back to the original decision when availability changed before acquire", () => {
    const accountPool = mockPool({ available: true, acquiredAccount: null });

    const result = prepareProxyFallbackAccountRetry({
      accountPool,
      model: "gpt-5.4",
      triedEntryIds: ["entry-1"],
      tag: "Test",
      decision: retryDecision({ status: 401, message: "token invalid", useFormat429: false }),
    });

    expect(result).toEqual({
      action: "respond",
      status: 401,
      message: "token invalid",
    });
  });
});
