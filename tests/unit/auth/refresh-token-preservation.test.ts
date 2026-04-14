/**
 * E2E test: refresh token must never be lost during token refresh.
 *
 * Exercises the full RefreshScheduler → AccountPool → AccountRegistry → persistence
 * pipeline with three server response variants:
 *   1. Server returns a new refresh_token (normal)
 *   2. Server returns refresh_token: null (edge case)
 *   3. Server omits refresh_token entirely (edge case)
 *
 * In all cases the persisted RT must be non-null after refresh completes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockConfig } from "@helpers/config.js";
import { setConfigForTesting, resetConfigForTesting } from "@src/config.js";

// ── Controllable mock for refreshAccessToken ─────────────────────

type TokenResponse = {
  access_token: string;
  refresh_token?: string | null;
  token_type: string;
};

let nextRefreshResponse: TokenResponse;

vi.mock("@src/auth/oauth-pkce.js", () => ({
  refreshAccessToken: vi.fn(async () => nextRefreshResponse),
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

vi.mock("@src/paths.js", () => ({
  getDataDir: () => "/tmp/test-rt-preservation",
  getConfigDir: () => "/tmp/test-rt-preservation",
}));

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    readFileSync: vi.fn(() => { throw new Error("ENOENT"); }),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
  };
});

// ── Helpers ──────────────────────────────────────────────────────

function makeFreshJwt(expOffsetSec: number): string {
  const header = btoa(JSON.stringify({ alg: "RS256" }));
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expOffsetSec }));
  return `${header}.${payload}.sig`;
}

function makeExpiredJwt(): string {
  return makeFreshJwt(-10);
}

// ── Tests ────────────────────────────────────────────────────────

describe("refresh token preservation", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setConfigForTesting(createMockConfig({
      auth: { refresh_enabled: true, refresh_margin_seconds: 300, refresh_concurrency: 5 },
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    resetConfigForTesting();
  });

  it("preserves RT when server returns a new refresh_token", async () => {
    const originalRT = "rt_original_permanent";
    const newRT = "rt_rotated_new";
    nextRefreshResponse = {
      access_token: makeFreshJwt(3600),
      refresh_token: newRT,
      token_type: "Bearer",
    };

    const { AccountPool } = await import("@src/auth/account-pool.js");
    const pool = new AccountPool({
      persistence: { load: () => ({ entries: [], needsPersist: false }), save: vi.fn() },
      rotationStrategy: "least_used",
      initialToken: null,
      rateLimitBackoffSeconds: 60,
    });

    const entryId = pool.addAccount(makeExpiredJwt(), originalRT);

    const { RefreshScheduler } = await import("@src/auth/refresh-scheduler.js");
    const scheduler = new RefreshScheduler(pool);

    // Let refresh complete
    await vi.advanceTimersByTimeAsync(35_000);

    const entry = pool.getEntry(entryId);
    expect(entry?.refreshToken).toBe(newRT);

    scheduler.destroy();
    pool.destroy();
  });

  it("preserves RT when server returns refresh_token: null", async () => {
    const originalRT = "rt_must_survive_null";
    nextRefreshResponse = {
      access_token: makeFreshJwt(3600),
      refresh_token: null as unknown as undefined,
      token_type: "Bearer",
    };

    const { AccountPool } = await import("@src/auth/account-pool.js");
    const pool = new AccountPool({
      persistence: { load: () => ({ entries: [], needsPersist: false }), save: vi.fn() },
      rotationStrategy: "least_used",
      initialToken: null,
      rateLimitBackoffSeconds: 60,
    });

    const entryId = pool.addAccount(makeExpiredJwt(), originalRT);

    const { RefreshScheduler } = await import("@src/auth/refresh-scheduler.js");
    const scheduler = new RefreshScheduler(pool);

    await vi.advanceTimersByTimeAsync(35_000);

    const entry = pool.getEntry(entryId);
    expect(entry?.refreshToken).toBe(originalRT);

    scheduler.destroy();
    pool.destroy();
  });

  it("preserves RT when server omits refresh_token field entirely", async () => {
    const originalRT = "rt_must_survive_undefined";
    nextRefreshResponse = {
      access_token: makeFreshJwt(3600),
      // no refresh_token field at all
      token_type: "Bearer",
    };

    const { AccountPool } = await import("@src/auth/account-pool.js");
    const pool = new AccountPool({
      persistence: { load: () => ({ entries: [], needsPersist: false }), save: vi.fn() },
      rotationStrategy: "least_used",
      initialToken: null,
      rateLimitBackoffSeconds: 60,
    });

    const entryId = pool.addAccount(makeExpiredJwt(), originalRT);

    const { RefreshScheduler } = await import("@src/auth/refresh-scheduler.js");
    const scheduler = new RefreshScheduler(pool);

    await vi.advanceTimersByTimeAsync(35_000);

    const entry = pool.getEntry(entryId);
    expect(entry?.refreshToken).toBe(originalRT);

    scheduler.destroy();
    pool.destroy();
  });

  it("preserves oaistb_rt_ when server returns no new RT", async () => {
    const originalRT = "oaistb_rt_one_time_token";
    nextRefreshResponse = {
      access_token: makeFreshJwt(3600),
      token_type: "Bearer",
      // No refresh_token — previously this would set RT to null
    };

    const { AccountPool } = await import("@src/auth/account-pool.js");
    const pool = new AccountPool({
      persistence: { load: () => ({ entries: [], needsPersist: false }), save: vi.fn() },
      rotationStrategy: "least_used",
      initialToken: null,
      rateLimitBackoffSeconds: 60,
    });

    const entryId = pool.addAccount(makeExpiredJwt(), originalRT);

    const { RefreshScheduler } = await import("@src/auth/refresh-scheduler.js");
    const scheduler = new RefreshScheduler(pool);

    await vi.advanceTimersByTimeAsync(35_000);

    const entry = pool.getEntry(entryId);
    expect(entry?.refreshToken).toBe(originalRT);

    scheduler.destroy();
    pool.destroy();
  });
});
