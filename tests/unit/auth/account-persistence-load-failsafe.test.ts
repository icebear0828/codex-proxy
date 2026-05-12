/**
 * Tests for AccountPersistence load-failure quarantine + circuit breaker.
 *
 * When `accounts.json` exists but cannot be parsed (truncated, invalid
 * JSON, wrong shape), `loadPersisted` must:
 *   1. Rename the corrupt file to `accounts.json.corrupt-<timestamp>.bak`
 *      so the next launch starts from a clean slate without losing the
 *      original bytes for debugging.
 *   2. Return `loadFailed: true` so AccountPool can flip the registry
 *      into a persist-disabled state and stop overwriting disk with the
 *      empty in-memory map.
 *   3. Emit an entry to the local error log so the Errors tab surfaces
 *      the failure.
 *
 * Missing-file is NOT a failure — first launch should keep `loadFailed`
 * false so persistence stays enabled.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";

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

function accountsPath(): string {
  return resolve(tmpData, "accounts.json");
}

function corruptBackupFiles(): string[] {
  return readdirSync(tmpData).filter((f) => f.startsWith("accounts.json.corrupt-"));
}

describe("AccountPersistence load failsafe", () => {
  beforeEach(() => {
    tmpData = mkdtempSync(resolve(tmpdir(), "codex-load-failsafe-"));
  });

  afterEach(() => {
    rmSync(tmpData, { recursive: true, force: true });
  });

  it("missing file → loadFailed=false, no quarantine, empty entries", async () => {
    const { createFsPersistence } = await freshModule();
    const persistence = createFsPersistence();

    const result = persistence.load();

    expect(result.entries).toEqual([]);
    expect(result.loadFailed).toBeFalsy();
    expect(corruptBackupFiles()).toEqual([]);
  });

  it("valid file with entries → loadFailed=false, entries returned", async () => {
    writeFileSync(
      accountsPath(),
      JSON.stringify({
        accounts: [
          {
            id: "abc",
            token: "tok",
            refreshToken: null,
            email: null,
            accountId: null,
            userId: null,
            label: null,
            planType: null,
            proxyApiKey: "pk",
            status: "active",
            usage: {
              request_count: 0,
              input_tokens: 0,
              output_tokens: 0,
              cached_tokens: 0,
              empty_response_count: 0,
              last_used: null,
            },
            addedAt: new Date().toISOString(),
            cachedQuota: null,
            quotaFetchedAt: null,
          },
        ],
      }),
      "utf-8",
    );

    const { createFsPersistence } = await freshModule();
    const result = createFsPersistence().load();

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].id).toBe("abc");
    expect(result.loadFailed).toBeFalsy();
    expect(corruptBackupFiles()).toEqual([]);
  });

  it("malformed JSON → loadFailed=true, file quarantined, registry stays empty", async () => {
    writeFileSync(accountsPath(), "{not valid json", "utf-8");

    const { createFsPersistence } = await freshModule();
    const result = createFsPersistence().load();

    expect(result.loadFailed).toBe(true);
    expect(result.entries).toEqual([]);
    // Original file is renamed away
    expect(existsSync(accountsPath())).toBe(false);
    // Quarantine file exists with the corrupt content preserved
    const backups = corruptBackupFiles();
    expect(backups).toHaveLength(1);
    expect(readFileSync(resolve(tmpData, backups[0]!), "utf-8")).toBe("{not valid json");
  });

  it("empty file (0 bytes) → loadFailed=true + quarantined", async () => {
    writeFileSync(accountsPath(), "", "utf-8");

    const { createFsPersistence } = await freshModule();
    const result = createFsPersistence().load();

    expect(result.loadFailed).toBe(true);
    expect(existsSync(accountsPath())).toBe(false);
    expect(corruptBackupFiles()).toHaveLength(1);
  });

  it("valid JSON but wrong shape (accounts not an array) → loadFailed=true + quarantined", async () => {
    writeFileSync(accountsPath(), JSON.stringify({ accounts: "oops" }), "utf-8");

    const { createFsPersistence } = await freshModule();
    const result = createFsPersistence().load();

    expect(result.loadFailed).toBe(true);
    expect(existsSync(accountsPath())).toBe(false);
    expect(corruptBackupFiles()).toHaveLength(1);
  });

  it("quarantine filename uses timestamp so repeat failures don't clobber each other", async () => {
    // First failure
    writeFileSync(accountsPath(), "{bad1", "utf-8");
    let { createFsPersistence } = await freshModule();
    createFsPersistence().load();
    expect(corruptBackupFiles()).toHaveLength(1);

    // Second failure (simulate a later corrupt write)
    writeFileSync(accountsPath(), "{bad2", "utf-8");
    // Sleep ≥1ms to ensure timestamp differs even at ms granularity
    await new Promise((r) => setTimeout(r, 5));
    ({ createFsPersistence } = await freshModule());
    createFsPersistence().load();

    const backups = corruptBackupFiles();
    expect(backups).toHaveLength(2);
    const [b1, b2] = backups.sort().map((f) => readFileSync(resolve(tmpData, f), "utf-8"));
    expect(new Set([b1, b2])).toEqual(new Set(["{bad1", "{bad2"]));
  });
});
