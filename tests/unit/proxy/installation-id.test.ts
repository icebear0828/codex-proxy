import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { createHash } from "crypto";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let tmpHome: string;
let tmpData: string;

vi.mock("os", async (orig) => {
  const actual = await orig<typeof import("os")>();
  return { ...actual, homedir: () => tmpHome };
});

vi.mock("@src/paths.js", () => ({
  getDataDir: () => tmpData,
}));

async function freshModule() {
  vi.resetModules();
  return import("@src/proxy/installation-id.js");
}

describe("getInstallationId", () => {
  beforeEach(() => {
    tmpHome = mkdtempSync(resolve(tmpdir(), "codex-home-"));
    tmpData = mkdtempSync(resolve(tmpdir(), "codex-data-"));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpData, { recursive: true, force: true });
  });

  it("prefers ~/.codex/installation_id when present and valid", async () => {
    const codexDir = resolve(tmpHome, ".codex");
    require("fs").mkdirSync(codexDir, { recursive: true });
    const real = "9e16456f-3af3-4029-9479-0afa101a7485";
    writeFileSync(resolve(codexDir, "installation_id"), real, "utf-8");

    const { getInstallationId } = await freshModule();
    expect(getInstallationId()).toBe(real);
  });

  it("falls back to <dataDir>/installation_id when ~/.codex copy is missing", async () => {
    const persisted = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    writeFileSync(resolve(tmpData, "installation_id"), persisted, "utf-8");

    const { getInstallationId } = await freshModule();
    expect(getInstallationId()).toBe(persisted);
  });

  it("generates and persists a new UUID when no source exists", async () => {
    const { getInstallationId } = await freshModule();
    const got = getInstallationId();
    expect(got).toMatch(UUID_RE);
    const onDisk = readFileSync(resolve(tmpData, "installation_id"), "utf-8").trim();
    expect(onDisk).toBe(got);
  });

  it("ignores garbage in the source file and falls through", async () => {
    const codexDir = resolve(tmpHome, ".codex");
    require("fs").mkdirSync(codexDir, { recursive: true });
    writeFileSync(resolve(codexDir, "installation_id"), "not-a-uuid\n", "utf-8");

    const { getInstallationId } = await freshModule();
    const got = getInstallationId();
    expect(got).toMatch(UUID_RE);
    expect(existsSync(resolve(tmpData, "installation_id"))).toBe(true);
  });

  it("memoizes after first call", async () => {
    const { getInstallationId } = await freshModule();
    const first = getInstallationId();
    const second = getInstallationId();
    expect(first).toBe(second);
  });

  it("isolates installation_id per account (different accounts get different UUIDs)", async () => {
    const { getInstallationId } = await freshModule();
    const acct1 = getInstallationId("account-alpha");
    const acct2 = getInstallationId("account-beta");
    const globalId = getInstallationId();

    expect(acct1).toMatch(UUID_RE);
    expect(acct2).toMatch(UUID_RE);
    expect(acct1).not.toBe(acct2);
    expect(acct1).not.toBe(globalId);
    expect(acct2).not.toBe(globalId);

    // Stable on repeated calls
    expect(getInstallationId("account-alpha")).toBe(acct1);
    expect(getInstallationId("account-beta")).toBe(acct2);
  });

  it("persists account-scoped installation_id to disk and reloads it", async () => {
    const { getInstallationId } = await freshModule();
    const acctId = getInstallationId("account-gamma");

    const hashSuffix = createHash("sha256").update("account-gamma").digest("hex").slice(0, 8);
    const savedFile = resolve(tmpData, "installation_ids", `account-gamma_${hashSuffix}.id`);
    expect(existsSync(savedFile)).toBe(true);
    expect(readFileSync(savedFile, "utf-8").trim()).toBe(acctId);

    // Fresh module reload
    const fresh = await freshModule();
    expect(fresh.getInstallationId("account-gamma")).toBe(acctId);
  });

  it("differentiates accounts whose sanitized names might otherwise collide", async () => {
    const { getInstallationId } = await freshModule();
    const id1 = getInstallationId("acc:test");
    const id2 = getInstallationId("acc_test");

    expect(id1).not.toBe(id2);
  });
});

