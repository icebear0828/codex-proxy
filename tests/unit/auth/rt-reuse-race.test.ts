/**
 * Verify three RT-consumption failure modes are FIXED:
 *
 * 1. probeAccount skips when scheduler _inFlight (no race)
 * 2. Scheduler detects cross-process RT update from disk (no double-consume)
 * 3. Import stores null RT when server omits refresh_token (no dead RT)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockConfig } from "@helpers/config.js";
import { setConfigForTesting, resetConfigForTesting } from "@src/config.js";

// ── One-time RT simulation ──────────────────────────────────────────

const consumedRTs = new Set<string>();
const sentRTs: string[] = [];

const mockRefresh = vi.fn(async (rt: string) => {
  sentRTs.push(rt);

  if (consumedRTs.has(rt)) {
    throw new Error(
      'Token refresh failed (401): {"error":{"message":"Your refresh token has already been used","code":"refresh_token_reused"}}',
    );
  }
  consumedRTs.add(rt);

  const header = btoa(JSON.stringify({ alg: "RS256" }));
  const payload = btoa(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }),
  );
  return {
    access_token: `${header}.${payload}.sig`,
    refresh_token: `rt_rotated_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  };
});

vi.mock("@src/auth/oauth-pkce.js", () => ({
  refreshAccessToken: (...args: unknown[]) =>
    mockRefresh(args[0] as string),
}));

vi.mock("@src/auth/jwt-utils.js", () => ({
  decodeJwtPayload: (token: string) => {
    try {
      return JSON.parse(atob(token.split(".")[1]));
    } catch {
      return null;
    }
  },
  extractChatGptAccountId: () => "acct-test",
  extractUserProfile: () => ({
    email: "test@test.com",
    chatgpt_plan_type: "plus",
    chatgpt_user_id: "uid-test",
  }),
  isTokenExpired: (token: string) => {
    try {
      const p = JSON.parse(atob(token.split(".")[1]));
      return typeof p.exp === "number" && p.exp < Date.now() / 1000;
    } catch {
      return true;
    }
  },
}));

vi.mock("@src/utils/jitter.js", () => ({
  jitter: (val: number) => val,
  jitterInt: (val: number) => val,
}));

// ── Helpers ─────────────────────────────────────────────────────────

function makeJwt(offsetSec: number): string {
  const header = btoa(JSON.stringify({ alg: "RS256" }));
  const payload = btoa(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + offsetSec }),
  );
  return `${header}.${payload}.sig`;
}

interface MockEntry {
  id: string;
  token: string;
  refreshToken: string | null;
  email: string | null;
  status: string;
  accountId: string | null;
  userId: string | null;
  planType: string | null;
}

function makeEntry(id: string, rt: string, status = "expired"): MockEntry {
  return {
    id,
    token: makeJwt(3600),
    refreshToken: rt,
    email: `${id}@test.com`,
    status,
    accountId: null,
    userId: null,
    planType: null,
  };
}

function makePool(entries: MockEntry[], opts?: { diskRT?: string }) {
  return {
    getAllEntries: () => entries,
    getEntry: (id: string) => entries.find((e) => e.id === id) ?? null,
    markStatus: vi.fn((id: string, status: string) => {
      const e = entries.find((x) => x.id === id);
      if (e) e.status = status;
    }),
    updateToken: vi.fn((id: string, token: string, newRt?: string) => {
      const e = entries.find((x) => x.id === id);
      if (e) {
        e.token = token;
        if (typeof newRt === "string" && newRt.length > 0) {
          e.refreshToken = newRt;
        }
        e.status = "active";
      }
    }),
    /** Simulates reading the RT from accounts.json on disk. */
    readEntryRTFromDisk: vi.fn((_id: string) => opts?.diskRT ?? null),
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("RT reuse race conditions — fixes", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setConfigForTesting(
      createMockConfig({
        auth: {
          refresh_enabled: true,
          refresh_margin_seconds: 300,
          refresh_concurrency: 5,
        },
      }),
    );
    consumedRTs.clear();
    sentRTs.length = 0;
    mockRefresh.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetConfigForTesting();
  });

  // ────────────────────────────────────────────────────────────────────
  // 1. FIX: probeAccount skips when scheduler is already refreshing
  // ────────────────────────────────────────────────────────────────────

  it("probeAccount returns 'skipped' when scheduler is already refreshing", async () => {
    const rt = "rt_probe_skip_test";
    const entry = makeEntry("acc-skip", rt);
    const pool = makePool([entry]);

    const { probeAccount } = await import("@src/auth/health-check.js");

    // Simulate: scheduler reports this account as in-flight
    const scheduler = {
      scheduleOne: vi.fn(),
      clearOne: vi.fn(),
      isRefreshing: vi.fn((id: string) => id === "acc-skip"),
    };

    const result = await probeAccount(
      pool as never,
      scheduler as never,
      "acc-skip",
    );

    // Fix verified: probeAccount skips instead of racing
    expect(result.result).toBe("skipped");
    expect(result.error).toBe("refresh already in progress");

    // No refresh call was made — RT is safe
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("probeAccount proceeds when scheduler is NOT refreshing", async () => {
    const rt = "rt_probe_proceed_test";
    const entry = makeEntry("acc-proceed", rt, "active");
    const pool = makePool([entry]);

    const { probeAccount } = await import("@src/auth/health-check.js");

    const scheduler = {
      scheduleOne: vi.fn(),
      clearOne: vi.fn(),
      isRefreshing: vi.fn(() => false),
    };

    const result = await probeAccount(
      pool as never,
      scheduler as never,
      "acc-proceed",
    );

    expect(result.result).toBe("alive");
    expect(mockRefresh).toHaveBeenCalledOnce();
  });

  // ────────────────────────────────────────────────────────────────────
  // 2. FIX: scheduler detects cross-process RT update from disk
  // ────────────────────────────────────────────────────────────────────

  it("scheduler skips refresh when disk RT differs (another process updated it)", async () => {
    const staleRT = "rt_stale_in_memory";
    const freshRT = "rt_fresh_on_disk";
    const entry = makeEntry("acc-cross", staleRT);
    const pool = makePool([entry], { diskRT: freshRT });

    const { RefreshScheduler } = await import("@src/auth/refresh-scheduler.js");
    const scheduler = new RefreshScheduler(pool as never);

    // Let recovery timer fire (30s)
    await vi.advanceTimersByTimeAsync(35_000);

    // Fix verified: scheduler detected disk RT differs, synced without refreshing
    expect(entry.refreshToken).toBe(freshRT);
    expect(entry.status).toBe("active");

    // No refresh call — the stale RT was NOT sent to the server
    const staleCalls = sentRTs.filter((r) => r === staleRT);
    expect(staleCalls.length).toBe(0);

    scheduler.destroy();
  });

  it("scheduler proceeds normally when disk RT matches memory", async () => {
    const rt = "rt_matches_disk";
    const entry = makeEntry("acc-match", rt);
    // diskRT matches memory — no cross-process update
    const pool = makePool([entry], { diskRT: rt });

    const { RefreshScheduler } = await import("@src/auth/refresh-scheduler.js");
    const scheduler = new RefreshScheduler(pool as never);

    await vi.advanceTimersByTimeAsync(35_000);

    // Normal refresh happened
    expect(mockRefresh).toHaveBeenCalled();
    expect(sentRTs).toContain(rt);

    scheduler.destroy();
  });

  // ────────────────────────────────────────────────────────────────────
  // 3. FIX: import stores null RT when server omits refresh_token
  // ────────────────────────────────────────────────────────────────────

  it("import stores null RT when server returns no refresh_token (rt_ prefix)", async () => {
    vi.useRealTimers();

    const originalRT = "rt_import_no_rotation";

    const noRTRefresh = vi.fn(
      async (rt: string, _proxyUrl: string | null) => {
        consumedRTs.add(rt);
        return {
          access_token: makeJwt(3600),
          // server omits refresh_token
        };
      },
    );

    const { AccountImportService } = await import(
      "@src/services/account-import.js"
    );

    let storedRT: string | null | undefined = undefined;
    const mockPool = {
      getAllEntries: () => [],
      getAccounts: () =>
        storedRT !== undefined
          ? [{ id: "new-id", email: "test@test.com" }]
          : [],
      addAccount: vi.fn((_token: string, rt: string | null) => {
        storedRT = rt;
        return "new-id";
      }),
      getEntry: () => null,
      setLabel: vi.fn(),
      updateCachedQuota: vi.fn(),
    };

    const svc = new AccountImportService(
      mockPool as never,
      { scheduleOne: vi.fn() },
      {
        validateToken: (token: string) => {
          try {
            JSON.parse(atob(token.split(".")[1]));
            return { valid: true };
          } catch {
            return { valid: false, error: "bad token" };
          }
        },
        refreshToken: noRTRefresh,
        getProxyUrl: () => null,
      },
    );

    const result = await svc.importOne(undefined, originalRT);

    expect(result.ok).toBe(true);
    expect(consumedRTs.has(originalRT)).toBe(true);

    // Fix verified: stores null instead of the consumed dead RT
    expect(storedRT).toBeNull();
  });

  it("import stores new RT when server returns refresh_token", async () => {
    vi.useRealTimers();

    const originalRT = "rt_import_with_rotation";
    const rotatedRT = "rt_rotated_new_from_server";

    const withRTRefresh = vi.fn(
      async (rt: string, _proxyUrl: string | null) => {
        consumedRTs.add(rt);
        return {
          access_token: makeJwt(3600),
          refresh_token: rotatedRT,
        };
      },
    );

    const { AccountImportService } = await import(
      "@src/services/account-import.js"
    );

    let storedRT: string | null | undefined = undefined;
    const mockPool = {
      getAllEntries: () => [],
      getAccounts: () =>
        storedRT !== undefined
          ? [{ id: "new-id", email: "test@test.com" }]
          : [],
      addAccount: vi.fn((_token: string, rt: string | null) => {
        storedRT = rt;
        return "new-id";
      }),
      getEntry: () => null,
      setLabel: vi.fn(),
      updateCachedQuota: vi.fn(),
    };

    const svc = new AccountImportService(
      mockPool as never,
      { scheduleOne: vi.fn() },
      {
        validateToken: (token: string) => {
          try {
            JSON.parse(atob(token.split(".")[1]));
            return { valid: true };
          } catch {
            return { valid: false, error: "bad token" };
          }
        },
        refreshToken: withRTRefresh,
        getProxyUrl: () => null,
      },
    );

    const result = await svc.importOne(undefined, originalRT);

    expect(result.ok).toBe(true);
    // New RT from server is stored correctly
    expect(storedRT).toBe(rotatedRT);
  });
});
