import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => ({
    model: { default: "gpt-5.2-codex" },
  })),
}));

vi.mock("@src/paths.js", () => ({
  getConfigDir: vi.fn(() => "/tmp/test-config"),
  getDataDir: vi.fn(() => "/tmp/test-data"),
}));

const mockGetModels = vi.fn<() => Promise<Array<{ slug: string }>>>();

vi.mock("@src/proxy/codex-api.js", () => ({
  CodexApi: vi.fn().mockImplementation(() => ({
    getModels: mockGetModels,
  })),
}));

vi.mock("@src/models/model-store.js", () => ({
  applyBackendModelsForPlan: vi.fn(),
}));

vi.mock("@src/utils/jitter.js", () => ({
  jitter: vi.fn((ms: number) => ms),
}));

import type { AccountPool } from "@src/auth/account-pool.js";
import type { CookieJar } from "@src/proxy/cookie-jar.js";
import {
  startModelRefresh,
  stopModelRefresh,
  hasFetchedModels,
} from "@src/models/model-fetcher.js";

function createMockAccountPool(authenticated: boolean): AccountPool {
  return {
    isAuthenticated: vi.fn(() => authenticated),
    getDistinctPlanAccounts: vi.fn(() =>
      authenticated
        ? [{ planType: "team", entryId: "e1", token: "t1", accountId: "a1" }]
        : [],
    ),
    release: vi.fn(),
  } as unknown as AccountPool;
}

const mockCookieJar = {} as CookieJar;

describe("model-fetcher retry logic", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    stopModelRefresh();
  });

  afterEach(() => {
    stopModelRefresh();
    vi.useRealTimers();
  });

  it("retries when accounts are not authenticated at startup", async () => {
    const pool = createMockAccountPool(false);
    startModelRefresh(pool, mockCookieJar);

    expect(hasFetchedModels()).toBe(false);

    // Advance past initial delay (1s)
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pool.isAuthenticated).toHaveBeenCalled();
    expect(hasFetchedModels()).toBe(false);

    // Should retry at 10s intervals — advance to first retry
    await vi.advanceTimersByTimeAsync(10_000);
    expect((pool.isAuthenticated as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("succeeds on retry when accounts become ready", async () => {
    let authenticated = false;
    const pool = {
      isAuthenticated: vi.fn(() => authenticated),
      getDistinctPlanAccounts: vi.fn(() =>
        authenticated
          ? [{ planType: "free", entryId: "e1", token: "t1", accountId: "a1" }]
          : [],
      ),
      release: vi.fn(),
    } as unknown as AccountPool;

    mockGetModels.mockResolvedValue([{ slug: "gpt-5.4" }]);
    startModelRefresh(pool, mockCookieJar);

    // Initial attempt — not authenticated
    await vi.advanceTimersByTimeAsync(1_000);
    expect(hasFetchedModels()).toBe(false);

    // Now accounts become active
    authenticated = true;

    // Advance to first retry (10s)
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hasFetchedModels()).toBe(true);
  });

  it("falls back to hourly after max retries", async () => {
    const pool = createMockAccountPool(false);
    startModelRefresh(pool, mockCookieJar);

    // Initial delay + 12 retries × 10s = 1s + 120s
    await vi.advanceTimersByTimeAsync(1_000 + 12 * 10_000);
    expect(hasFetchedModels()).toBe(false);

    // Should have logged max retries and scheduled hourly
    // Verify no more retries by advancing another 10s
    const callsBefore = (pool.isAuthenticated as ReturnType<typeof vi.fn>).mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    const callsAfter = (pool.isAuthenticated as ReturnType<typeof vi.fn>).mock.calls.length;
    // No additional calls at 10s interval (hourly is much later)
    expect(callsAfter).toBe(callsBefore);
  });

  it("succeeds immediately when accounts are ready at startup", async () => {
    const pool = createMockAccountPool(true);
    mockGetModels.mockResolvedValue([{ slug: "gpt-5.4" }]);

    startModelRefresh(pool, mockCookieJar);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(hasFetchedModels()).toBe(true);
    expect(pool.release).toHaveBeenCalledWith("e1");
  });
});
