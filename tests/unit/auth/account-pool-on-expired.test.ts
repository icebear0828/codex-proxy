/**
 * Tests for AccountPool.onExpired callback — reactive refresh on 401.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMemoryPersistence } from "@helpers/account-pool-factory.js";
import { createValidJwt } from "@helpers/jwt.js";
import { createMockConfig } from "@helpers/config.js";
import { setConfigForTesting, resetConfigForTesting } from "@src/config.js";
import { AccountPool } from "@src/auth/account-pool.js";

describe("AccountPool.onExpired", () => {
  beforeEach(() => {
    setConfigForTesting(createMockConfig());
  });
  afterEach(() => {
    resetConfigForTesting();
  });

  it("fires callback when markStatus sets an account to expired", () => {
    const pool = new AccountPool({ persistence: createMemoryPersistence() });
    const id = pool.addAccount(createValidJwt({ accountId: "a1", email: "a1@test.com" }));

    const cb = vi.fn();
    pool.onExpired(cb);

    pool.markStatus(id, "expired");
    expect(cb).toHaveBeenCalledOnce();
    expect(cb).toHaveBeenCalledWith(id);
  });

  it("does not fire callback for non-expired status changes", () => {
    const pool = new AccountPool({ persistence: createMemoryPersistence() });
    const id = pool.addAccount(createValidJwt({ accountId: "a1", email: "a1@test.com" }));

    const cb = vi.fn();
    pool.onExpired(cb);

    pool.markStatus(id, "banned");
    pool.markStatus(id, "active");
    expect(cb).not.toHaveBeenCalled();
  });

  it("works without a registered callback", () => {
    const pool = new AccountPool({ persistence: createMemoryPersistence() });
    const id = pool.addAccount(createValidJwt({ accountId: "a1", email: "a1@test.com" }));

    // Should not throw
    pool.markStatus(id, "expired");
  });
});
