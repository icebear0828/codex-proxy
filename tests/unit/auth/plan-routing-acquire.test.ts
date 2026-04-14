/**
 * Tests that account-pool correctly routes requests based on model→plan mapping.
 *
 * Verifies the critical path: when a model is available to both free and team,
 * free accounts should be selected. When only team has it, free accounts must
 * NOT be used (return null instead of wrong account).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMemoryPersistence } from "@helpers/account-pool-factory.js";
import { createValidJwt } from "@helpers/jwt.js";
import { createMockConfig } from "@helpers/config.js";
import { setConfigForTesting, resetConfigForTesting } from "@src/config.js";
import { AccountPool } from "@src/auth/account-pool.js";
import { getModelPlanTypes, isPlanFetched } from "@src/models/model-store.js";

// Only model-store needs mocking (for plan-based routing logic)
vi.mock("@src/models/model-store.js", () => ({
  getModelPlanTypes: vi.fn(() => []),
  isPlanFetched: vi.fn(() => true),
  getModelInfo: vi.fn(() => null),
  parseModelName: vi.fn((m: string) => ({ modelId: m, serviceTier: null, reasoningEffort: null })),
}));

type AccountSpec = { accountId: string; planType: string; email: string };

function createPool(...specs: AccountSpec[]): { pool: AccountPool; jwts: Map<string, string> } {
  const pool = new AccountPool({ persistence: createMemoryPersistence() });
  const jwts = new Map<string, string>();
  for (const spec of specs) {
    const jwt = createValidJwt({ accountId: spec.accountId, planType: spec.planType, email: spec.email });
    jwts.set(spec.accountId, jwt);
    pool.addAccount(jwt);
  }
  return { pool, jwts };
}

describe("account-pool plan-based routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setConfigForTesting(createMockConfig({ auth: { max_concurrent_per_account: 1 } }));
    vi.mocked(getModelPlanTypes).mockReturnValue([]);
    vi.mocked(isPlanFetched).mockReturnValue(true);
  });
  afterEach(() => {
    resetConfigForTesting();
  });

  it("returns null when model only supports team but only free accounts exist", () => {
    vi.mocked(getModelPlanTypes).mockReturnValue(["team"]);
    const { pool } = createPool({ accountId: "free1", planType: "free", email: "free@test.com" });

    const acquired = pool.acquire({ model: "gpt-5.4" });
    expect(acquired).toBeNull();
  });

  it("acquires team account when model only supports team", () => {
    vi.mocked(getModelPlanTypes).mockReturnValue(["team"]);
    const { pool, jwts } = createPool(
      { accountId: "free1", planType: "free", email: "free@test.com" },
      { accountId: "team1", planType: "team", email: "team@test.com" },
    );

    const acquired = pool.acquire({ model: "gpt-5.4" });
    expect(acquired).not.toBeNull();
    expect(acquired!.token).toBe(jwts.get("team1"));
  });

  it("uses any account when model has no known plan requirements", () => {
    vi.mocked(getModelPlanTypes).mockReturnValue([]);
    const { pool } = createPool({ accountId: "free1", planType: "free", email: "free@test.com" });

    const acquired = pool.acquire({ model: "unknown-model" });
    expect(acquired).not.toBeNull();
  });

  it("after plan map update, free account can access previously team-only model", () => {
    const { pool, jwts } = createPool({ accountId: "free1", planType: "free", email: "free@test.com" });

    // Initially: gpt-5.4 only for team
    vi.mocked(getModelPlanTypes).mockReturnValue(["team"]);
    const before = pool.acquire({ model: "gpt-5.4" });
    expect(before).toBeNull(); // blocked

    // Backend updates: gpt-5.4 now available for free too
    vi.mocked(getModelPlanTypes).mockReturnValue(["free", "team"]);
    const after = pool.acquire({ model: "gpt-5.4" });
    expect(after).not.toBeNull();
    expect(after!.token).toBe(jwts.get("free1"));
  });

  it("prefers plan-matched accounts over others", () => {
    vi.mocked(getModelPlanTypes).mockReturnValue(["team"]);
    const { pool, jwts } = createPool(
      { accountId: "free1", planType: "free", email: "free1@test.com" },
      { accountId: "free2", planType: "free", email: "free2@test.com" },
      { accountId: "team1", planType: "team", email: "team@test.com" },
    );

    const acquired = pool.acquire({ model: "gpt-5.4" });
    expect(acquired).not.toBeNull();
    expect(acquired!.token).toBe(jwts.get("team1"));
  });

  it("acquires any account when model supports both free and team", () => {
    vi.mocked(getModelPlanTypes).mockReturnValue(["free", "team"]);
    const { pool, jwts } = createPool(
      { accountId: "free1", planType: "free", email: "free@test.com" },
      { accountId: "team1", planType: "team", email: "team@test.com" },
    );

    const acquired = pool.acquire({ model: "gpt-5.4" });
    expect(acquired).not.toBeNull();
    // Both are valid candidates, should get one of them
    const allTokens = [jwts.get("free1"), jwts.get("team1")];
    expect(allTokens).toContain(acquired!.token);
  });

  it("includes accounts whose plan was never fetched (unfetched = possibly compatible)", () => {
    // Model known to work on team, but free plan was never fetched
    vi.mocked(getModelPlanTypes).mockReturnValue(["team"]);
    vi.mocked(isPlanFetched).mockImplementation((plan: string) => plan === "team");

    const { pool } = createPool(
      { accountId: "free1", planType: "free", email: "free@test.com" },
      { accountId: "team1", planType: "team", email: "team@test.com" },
    );

    // Both accounts are candidates (team is known, free is unfetched → possibly compatible)
    const first = pool.acquire({ model: "gpt-5.4" });
    expect(first).not.toBeNull();

    // Second concurrent request should also succeed (two candidates available)
    const second = pool.acquire({ model: "gpt-5.4" });
    expect(second).not.toBeNull();
    expect(second!.token).not.toBe(first!.token);

    // Both tokens come from the pool
    const allTokens = new Set([pool.getEntry(first!.entryId)?.token, pool.getEntry(second!.entryId)?.token]);
    expect(allTokens.size).toBe(2);
  });

  it("excludes accounts whose plan was fetched but lacks the model", () => {
    // Model known to work on team; free plan was fetched and model is NOT in it
    vi.mocked(getModelPlanTypes).mockReturnValue(["team"]);
    vi.mocked(isPlanFetched).mockReturnValue(true); // both plans fetched

    const { pool, jwts } = createPool(
      { accountId: "free1", planType: "free", email: "free@test.com" },
      { accountId: "team1", planType: "team", email: "team@test.com" },
    );

    // Lock the team account
    const first = pool.acquire({ model: "gpt-5.4" });
    expect(first).not.toBeNull();
    expect(first!.token).toBe(jwts.get("team1"));

    // Second request — free plan was fetched and model is absent → null
    const second = pool.acquire({ model: "gpt-5.4" });
    expect(second).toBeNull();
  });

  it("unfetched plans are included even when model appears plan-locked", () => {
    // Model supports team only, no plans have been fetched, but only free accounts exist
    vi.mocked(getModelPlanTypes).mockReturnValue(["team"]);
    vi.mocked(isPlanFetched).mockReturnValue(false); // no plans fetched yet

    const { pool, jwts } = createPool({ accountId: "free1", planType: "free", email: "free@test.com" });

    // Free plan is unfetched → included as possibly compatible
    const acquired = pool.acquire({ model: "gpt-5.4" });
    expect(acquired).not.toBeNull();
    expect(acquired!.token).toBe(jwts.get("free1"));
  });
});
