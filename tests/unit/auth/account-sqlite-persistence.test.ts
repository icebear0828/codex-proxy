import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import type { AccountEntry, AccountsFile } from "@src/auth/types.js";

let tmpData: string;

vi.mock("@src/paths.js", () => ({
  getDataDir: () => tmpData,
}));

vi.mock("@src/config.js", () => ({
  getConfig: () => ({
    observability: { local_error_log: true, max_log_bytes: 10 * 1024 * 1024 },
    client: { app_version: "test" },
  }),
}));

async function freshModule() {
  vi.resetModules();
  return import("@src/auth/account-persistence.js");
}

function accountsJsonPath(): string {
  return resolve(tmpData, "accounts.json");
}

function accountsSqlitePath(): string {
  return resolve(tmpData, "accounts.sqlite");
}

function makeEntry(id: string, label: string | null = null): AccountEntry {
  return {
    id,
    token: `token-${id}`,
    refreshToken: `rt-${id}`,
    email: `${id}@test.com`,
    accountId: `acct-${id}`,
    userId: `user-${id}`,
    label,
    planType: "plus",
    proxyApiKey: `codex-proxy-${id}`,
    status: "active",
    usage: {
      request_count: 2,
      input_tokens: 30,
      output_tokens: 40,
      cached_tokens: 10,
      empty_response_count: 1,
      last_used: "2026-01-02T03:04:05.000Z",
      rate_limit_until: null,
      window_request_count: 2,
      window_input_tokens: 30,
      window_output_tokens: 40,
      window_cached_tokens: 10,
      window_counters_reset_at: "2026-01-02T00:00:00.000Z",
      limit_window_seconds: 18_000,
    },
    addedAt: "2026-01-01T00:00:00.000Z",
    cachedQuota: {
      plan_type: "plus",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        used_percent: 12,
        reset_at: 1_767_222_000,
        limit_window_seconds: 18_000,
      },
      secondary_rate_limit: null,
      code_review_rate_limit: null,
    },
    quotaFetchedAt: "2026-01-02T03:00:00.000Z",
  };
}

function writeAccountsJson(entries: AccountEntry[]): void {
  writeFileSync(accountsJsonPath(), JSON.stringify({ accounts: entries }, null, 2), "utf-8");
}

function readAccountsJson(): AccountsFile {
  return JSON.parse(readFileSync(accountsJsonPath(), "utf-8")) as AccountsFile;
}

describe("SQLite account persistence", () => {
  beforeEach(() => {
    tmpData = mkdtempSync(resolve(tmpdir(), "codex-accounts-sqlite-"));
  });

  afterEach(() => {
    rmSync(tmpData, { recursive: true, force: true });
  });

  it("migrates existing accounts.json to accounts.sqlite without deleting the JSON fallback", async () => {
    const entry = makeEntry("legacy", "Legacy Label");
    writeAccountsJson([entry]);

    const { createFsPersistence } = await freshModule();
    const firstLoad = createFsPersistence().load();

    expect(firstLoad.loadFailed).toBeFalsy();
    expect(firstLoad.entries).toHaveLength(1);
    expect(firstLoad.entries[0]).toMatchObject({
      id: "legacy",
      label: "Legacy Label",
      refreshToken: "rt-legacy",
      cachedQuota: entry.cachedQuota,
    });
    expect(existsSync(accountsSqlitePath())).toBe(true);
    expect(existsSync(accountsJsonPath())).toBe(true);

    rmSync(accountsJsonPath());

    const secondLoad = createFsPersistence().load();
    expect(secondLoad.loadFailed).toBeFalsy();
    expect(secondLoad.entries).toHaveLength(1);
    expect(secondLoad.entries[0].id).toBe("legacy");
    expect(secondLoad.entries[0].label).toBe("Legacy Label");
  });

  it("keeps accounts.json mirrored after SQLite saves so downgrade fallback remains usable", async () => {
    const entry = makeEntry("mirror", "Before");
    writeAccountsJson([entry]);

    const { createFsPersistence } = await freshModule();
    const persistence = createFsPersistence();
    const loaded = persistence.load();

    expect(existsSync(accountsSqlitePath())).toBe(true);

    const updated = loaded.entries.map((account) => (
      account.id === "mirror" ? { ...account, label: "After" } : account
    ));
    persistence.save(updated);

    expect(readAccountsJson().accounts).toHaveLength(1);
    expect(readAccountsJson().accounts[0].label).toBe("After");

    rmSync(accountsSqlitePath());

    const fallbackLoad = createFsPersistence().load();
    expect(fallbackLoad.entries).toHaveLength(1);
    expect(fallbackLoad.entries[0].label).toBe("After");
  });

  it("falls back to healthy accounts.json when SQLite is unavailable", async () => {
    const entry = makeEntry("fallback", "Fallback");
    writeAccountsJson([entry]);
    writeFileSync(accountsSqlitePath(), "not a sqlite database", "utf-8");

    const { createFsPersistence } = await freshModule();
    const persistence = createFsPersistence();
    const result = persistence.load();

    expect(result.loadFailed).toBeFalsy();
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].id).toBe("fallback");

    persistence.save([{ ...result.entries[0], label: "Fallback Saved" }]);
    expect(readAccountsJson().accounts[0].label).toBe("Fallback Saved");
  });

  it("reports load failure when SQLite is corrupt and no JSON fallback exists", async () => {
    writeFileSync(accountsSqlitePath(), "not a sqlite database", "utf-8");

    const { createFsPersistence } = await freshModule();
    const result = createFsPersistence().load();

    expect(result.loadFailed).toBe(true);
    expect(result.health).toMatchObject({
      quarantined: true,
      store: "accounts.sqlite",
    });
    expect(existsSync(accountsSqlitePath())).toBe(false);
    expect(
      readdirSync(tmpData).some((name) => (
        name.startsWith("accounts.sqlite.corrupt-") && name.endsWith(".bak")
      )),
    ).toBe(true);
  });

  it("migrates legacy JSON entries that omit nullable fields into SQLite", async () => {
    const legacy = makeEntry("missing-nullables", null);
    const rawLegacy = { ...legacy } as Record<string, unknown>;
    delete rawLegacy.refreshToken;
    delete rawLegacy.email;
    delete rawLegacy.accountId;
    delete rawLegacy.userId;
    delete rawLegacy.label;
    delete rawLegacy.planType;
    writeFileSync(
      accountsJsonPath(),
      JSON.stringify({ accounts: [rawLegacy] }, null, 2),
      "utf-8",
    );

    const { createFsPersistence } = await freshModule();
    const firstLoad = createFsPersistence().load();

    expect(firstLoad.loadFailed).toBeFalsy();
    expect(firstLoad.entries[0]).toMatchObject({
      id: "missing-nullables",
      refreshToken: null,
      email: null,
      accountId: null,
      userId: null,
      label: null,
      planType: null,
    });
    expect(existsSync(accountsSqlitePath())).toBe(true);

    rmSync(accountsJsonPath());

    const sqliteReload = createFsPersistence().load();
    expect(sqliteReload.loadFailed).toBeFalsy();
    expect(sqliteReload.entries[0]).toMatchObject({
      id: "missing-nullables",
      refreshToken: null,
      email: null,
      accountId: null,
      userId: null,
      label: null,
      planType: null,
    });
  });

  it("reads refresh tokens from SQLite before a stale JSON mirror", async () => {
    const entry = makeEntry("rt-source", "rt-json-original");
    writeAccountsJson([entry]);

    const { createFsPersistence } = await freshModule();
    const persistence = createFsPersistence();
    const loaded = persistence.load();
    persistence.save([{ ...loaded.entries[0], refreshToken: "rt-sqlite-new" }]);

    writeAccountsJson([{ ...entry, refreshToken: "rt-json-stale" }]);

    const readablePersistence = persistence as {
      readRefreshToken?: (entryId: string) => string | null;
    };
    expect(readablePersistence.readRefreshToken?.("rt-source")).toBe("rt-sqlite-new");
  });
});
