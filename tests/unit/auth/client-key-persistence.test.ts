import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ClientKeyPersistence } from "../../../src/auth/client-key-persistence.js";
import type { ClientKeyEntry } from "../../../src/auth/client-key-types.js";

describe("ClientKeyPersistence", () => {
  let tempDir: string;
  let sqlitePath: string;
  let jsonPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "client-key-persistence-test-"));
    sqlitePath = join(tempDir, "client-keys.sqlite");
    jsonPath = join(tempDir, "client-keys.json");
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  const sampleKey: ClientKeyEntry = {
    id: "ck_test123",
    name: "Test Client",
    key: "sk-proxy-test1234567890abcdef",
    status: "active",
    expires_at: "2026-12-31T23:59:59.000Z",
    max_budget_usd: 10.0,
    used_cost_usd: 1.5,
    max_tokens: 100000,
    used_tokens: 15000,
    max_concurrency: 2,
    allowed_models: ["gpt-5.4", "gpt-5.3-codex"],
    default_tools: null,
    request_count: 5,
    last_used_at: "2026-08-15T12:00:00.000Z",
    created_at: "2026-08-15T00:00:00.000Z",
    updated_at: "2026-08-15T12:00:00.000Z",
  };

  it("initializes empty database and saves/loads keys", () => {
    const persistence = new ClientKeyPersistence(sqlitePath, jsonPath);
    const initial = persistence.load();
    expect(initial).toEqual([]);

    persistence.save([sampleKey]);

    const loaded = persistence.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual(sampleKey);
    expect(existsSync(sqlitePath)).toBe(true);
    expect(existsSync(jsonPath)).toBe(true);
  });

  it("updates existing key and removes deleted keys", () => {
    const persistence = new ClientKeyPersistence(sqlitePath, jsonPath);
    persistence.save([sampleKey]);

    const updatedKey: ClientKeyEntry = {
      ...sampleKey,
      used_cost_usd: 3.0,
      used_tokens: 30000,
      request_count: 10,
    };
    persistence.save([updatedKey]);

    const loaded = persistence.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].used_cost_usd).toBe(3.0);
    expect(loaded[0].request_count).toBe(10);

    persistence.save([]);
    expect(persistence.load()).toHaveLength(0);
  });

  it("recovers from json when sqlite is corrupted", () => {
    const persistence1 = new ClientKeyPersistence(sqlitePath, jsonPath);
    persistence1.save([sampleKey]);

    // Corrupt SQLite file with garbage
    writeFileSync(sqlitePath, "CORRUPT SQLITE NOT A DB HEADER");

    const persistence2 = new ClientKeyPersistence(sqlitePath, jsonPath);
    const loaded = persistence2.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe(sampleKey.id);
  });

  it("throws error on save failure without swallowing exception", () => {
    // A regular file as a parent directory will fail mkdir/open
    const blockingFile = join(tempDir, "file_blocking_dir");
    writeFileSync(blockingFile, "block");
    const invalidSqlite = join(blockingFile, "sub", "test.sqlite");
    const invalidJson = join(blockingFile, "sub", "test.json");

    const persistence = new ClientKeyPersistence(invalidSqlite, invalidJson);
    expect(() => persistence.save([sampleKey])).toThrow();
  });

  it("falls back to json persistence when sqlite is unavailable during save", () => {
    // A directory blocking SQLite path creation
    const blockingDir = join(tempDir, "blocking_sqlite_dir.sqlite");
    writeFileSync(blockingDir, "not a directory");

    const persistence = new ClientKeyPersistence(join(blockingDir, "nested.sqlite"), jsonPath);
    // Should save to JSON without throwing
    persistence.save([sampleKey]);

    expect(existsSync(jsonPath)).toBe(true);
    const loaded = persistence.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe(sampleKey.id);
  });

  it("migrates existing json keys when sqlite database is newly initialized and empty", () => {
    // Write pre-existing keys to JSON file before SQLite exists
    writeFileSync(jsonPath, JSON.stringify([sampleKey], null, 2), "utf-8");

    const persistence = new ClientKeyPersistence(sqlitePath, jsonPath);
    const loaded = persistence.load();

    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe(sampleKey.id);

    // Verify it was persisted to SQLite as well
    const persistenceAfter = new ClientKeyPersistence(sqlitePath, jsonPath);
    const loadedFromSqlite = persistenceAfter.load();
    expect(loadedFromSqlite).toHaveLength(1);
    expect(loadedFromSqlite[0].id).toBe(sampleKey.id);
  });

  it("recovers from json on subsequent load after sqlite save failure", () => {
    const persistence = new ClientKeyPersistence(sqlitePath, jsonPath);
    persistence.save([sampleKey]);

    // Force SQLite to fail by making SQLite path a directory or invalid
    // Save a new key which will fallback to JSON
    const newKey: ClientKeyEntry = { ...sampleKey, id: "ck_new456", name: "New Key" };
    // Simulate SQLite becoming corrupt/unwritable
    writeFileSync(sqlitePath, "CORRUPT SQLITE NOT A DB HEADER");

    // Recreate persistence to test recovery
    const persistence2 = new ClientKeyPersistence(sqlitePath, jsonPath);
    persistence2.save([newKey]);

    const loaded = persistence2.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe("ck_new456");
  });
});

