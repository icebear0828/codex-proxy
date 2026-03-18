/**
 * Tests for sticky rotation strategy in AccountPool.
 *
 * Sticky: prefer the most recently used account, keeping it in use
 * until rate-limited or quota-exhausted.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

let mockStrategy: "least_used" | "round_robin" | "sticky" = "sticky";

const mockGetModelPlanTypes = vi.fn<(id: string) => string[]>(() => []);

vi.mock("../../models/model-store.js", () => ({
  getModelPlanTypes: (...args: unknown[]) => mockGetModelPlanTypes(args[0] as string),
}));

vi.mock("../../config.js", () => ({
  getConfig: vi.fn(() => ({
    server: { proxy_api_key: null },
    auth: { jwt_token: "", rotation_strategy: mockStrategy, rate_limit_backoff_seconds: 60 },
  })),
}));

let profileForToken: Record<string, { chatgpt_plan_type: string; email: string }> = {};

vi.mock("../../auth/jwt-utils.js", () => ({
  isTokenExpired: vi.fn(() => false),
  decodeJwtPayload: vi.fn(() => ({ exp: Math.floor(Date.now() / 1000) + 3600 })),
  extractChatGptAccountId: vi.fn((token: string) => `aid-${token}`),
  extractUserProfile: vi.fn((token: string) => profileForToken[token] ?? null),
}));

vi.mock("../../utils/jitter.js", () => ({
  jitter: vi.fn((val: number) => val),
}));

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => JSON.stringify({ accounts: [] })),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
}));

import { AccountPool } from "../account-pool.js";

describe("account-pool sticky strategy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    profileForToken = {};
    mockStrategy = "sticky";
  });

  it("selects account with most recent last_used", () => {
    profileForToken = {
      "tok-a": { chatgpt_plan_type: "free", email: "a@test.com" },
      "tok-b": { chatgpt_plan_type: "free", email: "b@test.com" },
      "tok-c": { chatgpt_plan_type: "free", email: "c@test.com" },
    };

    const pool = new AccountPool();
    const idA = pool.addAccount("tok-a");
    const idB = pool.addAccount("tok-b");
    const idC = pool.addAccount("tok-c");

    // Simulate: B was used most recently, then A, then C
    const entryC = pool.getEntry(idC)!;
    entryC.usage.last_used = new Date(Date.now() - 30_000).toISOString();
    entryC.usage.request_count = 1;

    const entryA = pool.getEntry(idA)!;
    entryA.usage.last_used = new Date(Date.now() - 10_000).toISOString();
    entryA.usage.request_count = 2;

    const entryB = pool.getEntry(idB)!;
    entryB.usage.last_used = new Date(Date.now() - 1_000).toISOString();
    entryB.usage.request_count = 5;

    // Sticky should pick B (most recent last_used) despite having most requests
    const acquired = pool.acquire();
    expect(acquired).not.toBeNull();
    expect(acquired!.entryId).toBe(idB);
    pool.release(acquired!.entryId);
  });

  it("sticks to same account across multiple acquire/release cycles", () => {
    profileForToken = {
      "tok-a": { chatgpt_plan_type: "free", email: "a@test.com" },
      "tok-b": { chatgpt_plan_type: "free", email: "b@test.com" },
    };

    const pool = new AccountPool();
    pool.addAccount("tok-a");
    pool.addAccount("tok-b");

    // First acquire picks one (arbitrary from fresh pool)
    const first = pool.acquire()!;
    pool.release(first.entryId);

    // Subsequent acquires should stick to the same account
    for (let i = 0; i < 5; i++) {
      const next = pool.acquire()!;
      expect(next.entryId).toBe(first.entryId);
      pool.release(next.entryId);
    }
  });

  it("falls back when current account is rate-limited", () => {
    profileForToken = {
      "tok-a": { chatgpt_plan_type: "free", email: "a@test.com" },
      "tok-b": { chatgpt_plan_type: "free", email: "b@test.com" },
    };

    const pool = new AccountPool();
    const idA = pool.addAccount("tok-a");
    const idB = pool.addAccount("tok-b");

    // Make A the sticky choice
    const entryA = pool.getEntry(idA)!;
    entryA.usage.last_used = new Date().toISOString();
    entryA.usage.request_count = 5;

    // Rate-limit A
    pool.markRateLimited(idA, { retryAfterSec: 300 });

    // Should fall back to B
    const acquired = pool.acquire();
    expect(acquired).not.toBeNull();
    expect(acquired!.entryId).toBe(idB);
    pool.release(acquired!.entryId);
  });

  it("picks first available when no account has been used yet", () => {
    profileForToken = {
      "tok-a": { chatgpt_plan_type: "free", email: "a@test.com" },
      "tok-b": { chatgpt_plan_type: "free", email: "b@test.com" },
      "tok-c": { chatgpt_plan_type: "free", email: "c@test.com" },
    };

    const pool = new AccountPool();
    pool.addAccount("tok-a");
    pool.addAccount("tok-b");
    pool.addAccount("tok-c");

    // All accounts have null last_used — should pick one
    const first = pool.acquire();
    expect(first).not.toBeNull();
    pool.release(first!.entryId);

    // After releasing, the same one should be sticky
    const second = pool.acquire();
    expect(second).not.toBeNull();
    expect(second!.entryId).toBe(first!.entryId);
    pool.release(second!.entryId);
  });

  it("respects model filtering", () => {
    profileForToken = {
      "tok-free": { chatgpt_plan_type: "free", email: "free@test.com" },
      "tok-team": { chatgpt_plan_type: "team", email: "team@test.com" },
    };
    mockGetModelPlanTypes.mockReturnValue(["team"]);

    const pool = new AccountPool();
    const idFree = pool.addAccount("tok-free");
    const idTeam = pool.addAccount("tok-team");

    // Use the free account more recently
    const entryFree = pool.getEntry(idFree)!;
    entryFree.usage.last_used = new Date().toISOString();
    entryFree.usage.request_count = 10;

    // Model requires team plan — sticky should pick team account despite free being more recent
    const acquired = pool.acquire({ model: "gpt-5.4" });
    expect(acquired).not.toBeNull();
    expect(acquired!.entryId).toBe(idTeam);
    pool.release(acquired!.entryId);
  });

  it("least_used still works (regression guard)", () => {
    mockStrategy = "least_used";
    profileForToken = {
      "tok-a": { chatgpt_plan_type: "free", email: "a@test.com" },
      "tok-b": { chatgpt_plan_type: "free", email: "b@test.com" },
    };

    const pool = new AccountPool();
    const idA = pool.addAccount("tok-a");
    const idB = pool.addAccount("tok-b");

    // A has more requests — least_used should prefer B
    const entryA = pool.getEntry(idA)!;
    entryA.usage.request_count = 10;
    entryA.usage.last_used = new Date().toISOString();

    const entryB = pool.getEntry(idB)!;
    entryB.usage.request_count = 2;

    const acquired = pool.acquire();
    expect(acquired).not.toBeNull();
    expect(acquired!.entryId).toBe(idB);
    pool.release(acquired!.entryId);
  });
});
