import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AccountEntry, AccountsFile } from "@src/auth/types.js";

// Must use vi.hoisted() for mock variables referenced in vi.mock factories
const mockFs = vi.hoisted(() => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("fs", () => mockFs);

vi.mock("@src/paths.js", () => ({
  getDataDir: vi.fn(() => "/tmp/test-persistence"),
}));

vi.mock("@src/auth/jwt-utils.js", () => ({
  extractChatGptAccountId: vi.fn((token: string) => `acct-${token}`),
  extractUserProfile: vi.fn(() => null),
  isTokenExpired: vi.fn(() => false),
}));

import { createFsPersistence } from "@src/auth/account-persistence.js";

function makeEntry(id: string): AccountEntry {
  return {
    id,
    token: `tok-${id}`,
    refreshToken: null,
    email: `${id}@test.com`,
    accountId: `acct-${id}`,
    userId: `user-${id}`,
    planType: "free",
    proxyApiKey: `key-${id}`,
    status: "active",
    usage: {
      request_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      empty_response_count: 0,
      last_used: null,
      rate_limit_until: null,
      window_request_count: 0,
      window_input_tokens: 0,
      window_output_tokens: 0,
      window_counters_reset_at: null,
      limit_window_seconds: null,
    },
    addedAt: new Date().toISOString(),
    cachedQuota: null,
    quotaFetchedAt: null,
  };
}

describe("account-persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFs.existsSync.mockReturnValue(false);
  });

  describe("load", () => {
    it("returns empty entries when no files exist", () => {
      const p = createFsPersistence();
      const result = p.load();
      expect(result.entries).toEqual([]);
      expect(result.needsPersist).toBe(false);
    });

    it("loads from accounts.json", () => {
      const entry = makeEntry("a");
      const data: AccountsFile = { accounts: [entry] };
      mockFs.existsSync.mockImplementation(((path: string) =>
        path.includes("accounts.json")) as () => boolean,
      );
      mockFs.readFileSync.mockReturnValue(JSON.stringify(data));

      const p = createFsPersistence();
      const result = p.load();
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].id).toBe("a");
    });

    it("skips entries without id or token", () => {
      const data = { accounts: [{ id: "", token: "x" }, { id: "b" }] };
      mockFs.existsSync.mockImplementation(((path: string) =>
        path.includes("accounts.json")) as () => boolean,
      );
      mockFs.readFileSync.mockReturnValue(JSON.stringify(data));

      const p = createFsPersistence();
      expect(p.load().entries).toEqual([]);
    });

    it("backfills missing empty_response_count and auto-persists", () => {
      const entry = makeEntry("a");
      (entry.usage as unknown as Record<string, unknown>).empty_response_count = undefined;
      const data: AccountsFile = { accounts: [entry] };
      mockFs.existsSync.mockImplementation(((path: string) =>
        path.includes("accounts.json")) as () => boolean,
      );
      mockFs.readFileSync.mockReturnValue(JSON.stringify(data));

      const p = createFsPersistence();
      const result = p.load();
      expect(result.entries[0].usage.empty_response_count).toBe(0);
      expect(result.needsPersist).toBe(true);
      // Verify auto-persist was triggered (write + rename for atomic save)
      expect(mockFs.writeFileSync).toHaveBeenCalledTimes(1);
      expect(mockFs.renameSync).toHaveBeenCalledTimes(1);
    });
  });

  describe("save", () => {
    it("writes atomically via tmp file + rename", () => {
      mockFs.existsSync.mockReturnValue(true);
      const p = createFsPersistence();
      const entry = makeEntry("a");

      p.save([entry]);

      expect(mockFs.writeFileSync).toHaveBeenCalledTimes(1);
      const writtenPath = mockFs.writeFileSync.mock.calls[0][0] as string;
      expect(writtenPath).toMatch(/accounts\.json\.tmp$/);
      expect(mockFs.renameSync).toHaveBeenCalledTimes(1);
    });

    it("creates directory if missing", () => {
      mockFs.existsSync.mockReturnValue(false);
      const p = createFsPersistence();
      p.save([makeEntry("a")]);

      expect(mockFs.mkdirSync).toHaveBeenCalledWith(
        expect.any(String),
        { recursive: true },
      );
    });

    it("serializes accounts as JSON", () => {
      mockFs.existsSync.mockReturnValue(true);
      const p = createFsPersistence();
      const entries = [makeEntry("a"), makeEntry("b")];
      p.save(entries);

      const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1] as string) as AccountsFile;
      expect(written.accounts).toHaveLength(2);
      expect(written.accounts[0].id).toBe("a");
      expect(written.accounts[1].id).toBe("b");
    });
  });

  describe("legacy migration", () => {
    it("migrates from auth.json when accounts.json does not exist", () => {
      const legacyData = {
        token: "legacy-token",
        proxyApiKey: "old-key",
        userInfo: { email: "old@test.com", planType: "free" },
      };
      mockFs.existsSync.mockImplementation(((path: string) => {
        if (path.includes("accounts.json")) return false;
        if (path.includes("auth.json")) return true;
        return false;
      }) as () => boolean);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(legacyData));

      const p = createFsPersistence();
      const result = p.load();
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].token).toBe("legacy-token");
      // Should rename old file
      expect(mockFs.renameSync).toHaveBeenCalled();
    });
  });
});
