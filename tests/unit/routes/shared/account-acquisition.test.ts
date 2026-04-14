import { describe, it, expect, vi, beforeEach } from "vitest";
import { acquireAccount, releaseAccount } from "@src/routes/shared/account-acquisition.js";

/* ── Minimal mock types matching AccountPool interface ── */
interface MockPool {
  acquire: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
  getEntry: ReturnType<typeof vi.fn>;
}

function createMockPool(): MockPool {
  return {
    acquire: vi.fn(),
    release: vi.fn(),
    getEntry: vi.fn(),
  };
}

describe("acquireAccount", () => {
  let pool: MockPool;

  beforeEach(() => {
    pool = createMockPool();
  });

  it("delegates to pool.acquire with model and excludeIds", () => {
    pool.acquire.mockReturnValue({ entryId: "e1", token: "t1", accountId: "a1" });

    const result = acquireAccount(pool as never, "gpt-5.4", ["x1"], "OpenAI");

    expect(pool.acquire).toHaveBeenCalledWith({ model: "gpt-5.4", excludeIds: ["x1"], preferredEntryId: undefined });
    expect(result).toEqual({ entryId: "e1", token: "t1", accountId: "a1" });
  });

  it("passes preferredEntryId for session affinity", () => {
    pool.acquire.mockReturnValue({ entryId: "e1", token: "t1", accountId: "a1" });

    acquireAccount(pool as never, "gpt-5.4", undefined, "OpenAI", "e1");

    expect(pool.acquire).toHaveBeenCalledWith({ model: "gpt-5.4", excludeIds: undefined, preferredEntryId: "e1" });
  });

  it("returns null when pool has no available account", () => {
    pool.acquire.mockReturnValue(null);

    const result = acquireAccount(pool as never, "gpt-5.4", [], "OpenAI");

    expect(result).toBeNull();
  });

  it("passes empty excludeIds by default", () => {
    pool.acquire.mockReturnValue({ entryId: "e1", token: "t1", accountId: null });

    acquireAccount(pool as never, "gpt-5.4", undefined, "OpenAI");

    expect(pool.acquire).toHaveBeenCalledWith({ model: "gpt-5.4", excludeIds: undefined, preferredEntryId: undefined });
  });
});

describe("releaseAccount", () => {
  let pool: MockPool;

  beforeEach(() => {
    pool = createMockPool();
  });

  it("delegates to pool.release with entryId and usage", () => {
    const usage = { input_tokens: 10, output_tokens: 20 };
    releaseAccount(pool as never, "e1", usage);

    expect(pool.release).toHaveBeenCalledWith("e1", usage);
  });

  it("releases without usage when not provided", () => {
    releaseAccount(pool as never, "e1");

    expect(pool.release).toHaveBeenCalledWith("e1", undefined);
  });

  it("is idempotent — second call with same entryId is a no-op", () => {
    const guard = new Set<string>();

    releaseAccount(pool as never, "e1", undefined, guard);
    releaseAccount(pool as never, "e1", undefined, guard);

    expect(pool.release).toHaveBeenCalledTimes(1);
  });

  it("releases different entryIds independently", () => {
    const guard = new Set<string>();

    releaseAccount(pool as never, "e1", undefined, guard);
    releaseAccount(pool as never, "e2", undefined, guard);

    expect(pool.release).toHaveBeenCalledTimes(2);
  });
});
