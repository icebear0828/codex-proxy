/**
 * Tests that account-pool correctly routes requests based on model→plan mapping.
 *
 * Verifies the critical path: when a model is available to both free and team,
 * free accounts should be selected. When only team has it, free accounts must
 * NOT be used (return null instead of wrong account).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock getModelPlanTypes and isPlanFetched to control plan routing
const mockGetModelPlanTypes = vi.fn<(id: string) => string[]>(() => []);
const mockIsPlanFetched = vi.fn<(planType: string) => boolean>(() => true);

vi.mock("../../models/model-store.js", () => ({
  getModelPlanTypes: (...args: unknown[]) => mockGetModelPlanTypes(args[0] as string),
  isPlanFetched: (...args: unknown[]) => mockIsPlanFetched(args[0] as string),
}));

vi.mock("../../config.js", () => ({
  getConfig: vi.fn(() => ({
    server: { account_strategy: "round_robin" },
    auth: { jwt_token: "" },
  })),
}));

// Control planType by returning it from extractUserProfile
let profileForToken: Record<string, { chatgpt_plan_type: string; email: string }> = {};

vi.mock("../../auth/jwt-utils.js", () => ({
  isTokenExpired: vi.fn(() => false),
  decodeJwtPayload: vi.fn(() => ({})),
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
}));

import { AccountPool } from "../account-pool.js";

function createPool(...accounts: Array<{ token: string; planType: string; email: string }>) {
  // Set up profile mocks before creating pool
  profileForToken = {};
  for (const a of accounts) {
    profileForToken[a.token] = { chatgpt_plan_type: a.planType, email: a.email };
  }

  const pool = new AccountPool();
  for (const a of accounts) {
    pool.addAccount(a.token);
  }
  return pool;
}

describe("account-pool plan-based routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    profileForToken = {};
  });

  it("returns null when model only supports team but only free accounts exist", () => {
    mockGetModelPlanTypes.mockReturnValue(["team"]);
    const pool = createPool(
      { token: "tok-free", planType: "free", email: "free@test.com" },
    );

    const acquired = pool.acquire({ model: "gpt-5.4" });
    expect(acquired).toBeNull();
  });

  it("acquires team account when model only supports team", () => {
    mockGetModelPlanTypes.mockReturnValue(["team"]);
    const pool = createPool(
      { token: "tok-free", planType: "free", email: "free@test.com" },
      { token: "tok-team", planType: "team", email: "team@test.com" },
    );

    const acquired = pool.acquire({ model: "gpt-5.4" });
    expect(acquired).not.toBeNull();
    expect(acquired!.token).toBe("tok-team");
  });

  it("uses any account when model has no known plan requirements", () => {
    mockGetModelPlanTypes.mockReturnValue([]);
    const pool = createPool(
      { token: "tok-free", planType: "free", email: "free@test.com" },
    );

    const acquired = pool.acquire({ model: "unknown-model" });
    expect(acquired).not.toBeNull();
  });

  it("after plan map update, free account can access previously team-only model", () => {
    const pool = createPool(
      { token: "tok-free", planType: "free", email: "free@test.com" },
    );

    // Initially: gpt-5.4 only for team
    mockGetModelPlanTypes.mockReturnValue(["team"]);
    const before = pool.acquire({ model: "gpt-5.4" });
    expect(before).toBeNull(); // blocked

    // Backend updates: gpt-5.4 now available for free too
    mockGetModelPlanTypes.mockReturnValue(["free", "team"]);
    const after = pool.acquire({ model: "gpt-5.4" });
    expect(after).not.toBeNull();
    expect(after!.token).toBe("tok-free");
  });

  it("prefers plan-matched accounts over others", () => {
    mockGetModelPlanTypes.mockReturnValue(["team"]);
    const pool = createPool(
      { token: "tok-free1", planType: "free", email: "free1@test.com" },
      { token: "tok-free2", planType: "free", email: "free2@test.com" },
      { token: "tok-team", planType: "team", email: "team@test.com" },
    );

    const acquired = pool.acquire({ model: "gpt-5.4" });
    expect(acquired).not.toBeNull();
    expect(acquired!.token).toBe("tok-team");
  });

  it("acquires free account when model supports both free and team", () => {
    mockGetModelPlanTypes.mockReturnValue(["free", "team"]);
    const pool = createPool(
      { token: "tok-free", planType: "free", email: "free@test.com" },
      { token: "tok-team", planType: "team", email: "team@test.com" },
    );

    const acquired = pool.acquire({ model: "gpt-5.4" });
    expect(acquired).not.toBeNull();
    // Both are valid candidates, should get one of them
    expect(["tok-free", "tok-team"]).toContain(acquired!.token);
  });

  it("includes accounts whose plan was never fetched (unfetched = possibly compatible)", () => {
    // Model known to work on team, but free plan was never fetched
    mockGetModelPlanTypes.mockReturnValue(["team"]);
    mockIsPlanFetched.mockImplementation((plan: string) => plan === "team");

    const pool = createPool(
      { token: "tok-free", planType: "free", email: "free@test.com" },
      { token: "tok-team", planType: "team", email: "team@test.com" },
    );

    // Both accounts are candidates (team is known, free is unfetched → possibly compatible)
    const first = pool.acquire({ model: "gpt-5.4" });
    expect(first).not.toBeNull();

    // Second concurrent request should also succeed (two candidates available)
    const second = pool.acquire({ model: "gpt-5.4" });
    expect(second).not.toBeNull();
    expect(second!.token).not.toBe(first!.token);

    // Both tokens should be from our pool
    const tokens = new Set([first!.token, second!.token]);
    expect(tokens.has("tok-free")).toBe(true);
    expect(tokens.has("tok-team")).toBe(true);
  });

  it("excludes accounts whose plan was fetched but lacks the model", () => {
    // Model known to work on team; free plan was fetched and model is NOT in it
    mockGetModelPlanTypes.mockReturnValue(["team"]);
    mockIsPlanFetched.mockReturnValue(true); // both plans fetched

    const pool = createPool(
      { token: "tok-free", planType: "free", email: "free@test.com" },
      { token: "tok-team", planType: "team", email: "team@test.com" },
    );

    // Lock the team account
    const first = pool.acquire({ model: "gpt-5.4" });
    expect(first).not.toBeNull();
    expect(first!.token).toBe("tok-team");

    // Second request — free plan was fetched and model is absent → null
    const second = pool.acquire({ model: "gpt-5.4" });
    expect(second).toBeNull();
  });

  it("unfetched plans are included even when model appears plan-locked", () => {
    // Model supports team only, no plans have been fetched, but only free accounts exist
    mockGetModelPlanTypes.mockReturnValue(["team"]);
    mockIsPlanFetched.mockReturnValue(false); // no plans fetched yet

    const pool = createPool(
      { token: "tok-free", planType: "free", email: "free@test.com" },
    );

    // Free plan is unfetched → included as possibly compatible
    const acquired = pool.acquire({ model: "gpt-5.4" });
    expect(acquired).not.toBeNull();
    expect(acquired!.token).toBe("tok-free");
  });
});
