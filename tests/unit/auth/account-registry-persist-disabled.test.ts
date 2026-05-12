/**
 * Tests for AccountRegistry's persist-disabled circuit breaker.
 *
 * When AccountPersistence.load() returns `loadFailed: true`, the pool
 * constructs the registry with `persistDisabled: true`. In that state:
 *   - schedulePersist() and persistNow() must NOT call persistence.save()
 *   - In-memory CRUD still works (so the running session stays usable)
 *   - isPersistDisabled() returns true so the dashboard can render the
 *     "auto-save paused" banner.
 *
 * The whole point: a corrupt-load must not be silently followed by a
 * background save that overwrites the on-disk file with the empty map.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import "@helpers/account-pool-setup.js";
import { createMemoryPersistence } from "@helpers/account-pool-factory.js";
import { AccountPool } from "@src/auth/account-pool.js";
import { AccountRegistry } from "@src/auth/account-registry.js";
import { createValidJwt } from "@helpers/jwt.js";
import type { AccountEntry, AccountPersistence } from "@src/auth/account-persistence.js";

describe("AccountRegistry persistDisabled", () => {
  it("schedulePersist is a no-op when persistDisabled=true", () => {
    const persistence = createMemoryPersistence();
    const saveSpy = vi.spyOn(persistence, "save");
    const registry = new AccountRegistry(persistence, [], { persistDisabled: true });

    registry.schedulePersist();
    registry.persistNow();

    expect(saveSpy).not.toHaveBeenCalled();
    expect(registry.isPersistDisabled()).toBe(true);
  });

  it("schedulePersist DOES save when persistDisabled is false (default)", () => {
    const persistence = createMemoryPersistence();
    const saveSpy = vi.spyOn(persistence, "save");
    const registry = new AccountRegistry(persistence, []);

    registry.persistNow();

    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(registry.isPersistDisabled()).toBe(false);
  });

  it("addAccount keeps the entry in memory but does NOT trigger save when persistDisabled", () => {
    const persistence = createMemoryPersistence();
    const saveSpy = vi.spyOn(persistence, "save");
    const registry = new AccountRegistry(persistence, [], { persistDisabled: true });

    const id = registry.addAccount(createValidJwt({ email: "x@test.com" }));

    expect(registry.getEntry(id)).toBeDefined();
    expect(saveSpy).not.toHaveBeenCalled();
  });
});

describe("AccountPool propagates loadFailed → persistDisabled", () => {
  function makeLoadFailingPersistence(): AccountPersistence {
    return {
      load: () => ({ entries: [], needsPersist: false, loadFailed: true }),
      save: vi.fn(),
    };
  }

  function makeHealthyPersistence(initial: AccountEntry[] = []): AccountPersistence {
    return createMemoryPersistence(initial);
  }

  beforeEach(() => {
    vi.useRealTimers();
  });

  it("pool.isPersistDisabled() reflects load failure", () => {
    const persistence = makeLoadFailingPersistence();
    const pool = new AccountPool({ persistence, rotationStrategy: "round_robin", initialToken: null, rateLimitBackoffSeconds: 60 });

    expect(pool.isPersistDisabled()).toBe(true);
  });

  it("background mutations do NOT write to disk after load failure", async () => {
    const persistence = makeLoadFailingPersistence();
    const saveSpy = persistence.save as ReturnType<typeof vi.fn>;
    const pool = new AccountPool({ persistence, rotationStrategy: "round_robin", initialToken: null, rateLimitBackoffSeconds: 60 });

    // Simulate a downstream caller adding an account (e.g. dashboard import).
    // In-memory state should update for the running session, but disk MUST
    // stay untouched so the quarantined original is preserved.
    pool.addAccount(createValidJwt({ email: "y@test.com" }));

    // Drain any debounced save timers.
    await new Promise((r) => setTimeout(r, 1100));

    expect(saveSpy).not.toHaveBeenCalled();
    expect(pool.isPersistDisabled()).toBe(true);
  });

  it("healthy load → persistDisabled=false and saves work normally", () => {
    const persistence = makeHealthyPersistence();
    const saveSpy = vi.spyOn(persistence, "save");
    const pool = new AccountPool({ persistence, rotationStrategy: "round_robin", initialToken: null, rateLimitBackoffSeconds: 60 });

    expect(pool.isPersistDisabled()).toBe(false);
    pool.addAccount(createValidJwt({ email: "z@test.com" }));
    expect(saveSpy).toHaveBeenCalled();
  });
});
