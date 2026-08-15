/**
 * AccountPersistence — file-system persistence for AccountPool.
 * Handles load/save/migrate operations as an injectable dependency.
 */

import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdirSync,
} from "fs";
import { createRequire } from "module";
import { resolve, dirname } from "path";
import { randomBytes } from "crypto";
import { getDataDir } from "../paths.js";
import { appendErrorLog } from "../logs/error-log.js";
import {
  extractChatGptAccountId,
  extractUserProfile,
  isTokenExpired,
} from "./jwt-utils.js";
import type { AccountEntry, AccountsFile, CodexQuota } from "./types.js";

const require = createRequire(import.meta.url);

/**
 * Migrate a legacy entry to the new schema:
 *   status === "rate_limited" + usage.rate_limit_until  →  status="active" +
 *   cachedQuota.rate_limit.{limit_reached, reset_at}.
 *
 * Trust rule: if cachedQuota was fetched AFTER rate_limit_until was last set
 * (quotaFetchedAt > rate_limit_until), we treat cachedQuota as ground truth
 * and just drop the local lock. Otherwise we synthesize/overwrite the primary
 * bucket from rate_limit_until.
 *
 * Returns true when the entry was mutated.
 */
export function migrateLegacyRateLimit(entry: AccountEntry): boolean {
  const usage = entry.usage;
  const legacyUntil = usage.rate_limit_until;
  // On-disk shape pre-dates the enum narrowing; cast through string to compare
  // against the retired "rate_limited" literal without tripping TS no-overlap.
  const wasRateLimitedStatus = (entry.status as string) === "rate_limited";
  if (!wasRateLimitedStatus && !legacyUntil) return false;

  let mutated = false;

  if (wasRateLimitedStatus) {
    entry.status = "active";
    mutated = true;
  }

  if (legacyUntil) {
    const untilMs = Date.parse(legacyUntil);
    const untilSec = Number.isFinite(untilMs) ? Math.floor(untilMs / 1000) : 0;
    const inFuture = Number.isFinite(untilMs) && untilMs > Date.now();

    const fetchedMs = entry.quotaFetchedAt ? Date.parse(entry.quotaFetchedAt) : NaN;
    const cachedQuotaIsFresh =
      entry.cachedQuota != null &&
      Number.isFinite(fetchedMs) &&
      Number.isFinite(untilMs) &&
      fetchedMs > untilMs;

    if (inFuture && !cachedQuotaIsFresh) {
      const synthesized: CodexQuota = entry.cachedQuota ?? {
        plan_type: entry.planType ?? "unknown",
        rate_limit: {
          allowed: false,
          limit_reached: true,
          used_percent: 100,
          reset_at: untilSec,
          limit_window_seconds: usage.limit_window_seconds ?? null,
        },
        secondary_rate_limit: null,
        code_review_rate_limit: null,
      };
      synthesized.rate_limit = {
        ...synthesized.rate_limit,
        allowed: false,
        limit_reached: true,
        used_percent: Math.max(synthesized.rate_limit.used_percent ?? 0, 100),
        reset_at: untilSec,
      };
      entry.cachedQuota = synthesized;
      entry.quotaFetchedAt = new Date().toISOString();
    }

    usage.rate_limit_until = null;
    mutated = true;
  }

  return mutated;
}

export interface PersistenceLoadHealth {
  /**
   * Whether the corrupt account persistence file was successfully renamed aside.
   * False means the rename itself failed — the original file is still
   * on disk and the user-facing message must NOT instruct recovery
   * from a `.bak` that does not exist.
   */
  quarantined: boolean;
  /** Absolute path of the `.bak` file if quarantine succeeded. */
  backupPath: string | null;
  /** The account persistence file that failed to load. */
  store?: "accounts.json" | "accounts.sqlite";
}

export interface AccountPersistence {
  load(): {
    entries: AccountEntry[];
    needsPersist: boolean;
    loadFailed?: boolean;
    /** Populated when loadFailed=true so dashboard can show accurate recovery instructions. */
    health?: PersistenceLoadHealth;
  };
  save(accounts: AccountEntry[]): void;
  readRefreshToken?(entryId: string): string | null;
}

interface PersistenceLoadResult {
  entries: AccountEntry[];
  needsPersist: boolean;
  loadFailed?: boolean;
  health?: PersistenceLoadHealth;
}

interface SqliteRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): SqliteRunResult;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

type SqliteDatabaseConstructor = new (filename: string) => SqliteDatabase;

type SqliteLoadResult =
  | { ok: true; entries: AccountEntry[]; needsPersist: boolean }
  | { ok: false; error: unknown };

type SqliteRefreshTokenResult =
  | { ok: true; value: string | null }
  | { ok: false; error: unknown };

type PersistenceBackend = "sqlite" | "json" | null;

function getAccountsFile(): string {
  return resolve(getDataDir(), "accounts.json");
}
function getAccountsSqliteFile(): string {
  return resolve(getDataDir(), "accounts.sqlite");
}
function getLegacyAuthFile(): string {
  return resolve(getDataDir(), "auth.json");
}

export function createFsPersistence(): AccountPersistence {
  // Once a load discovers `accounts.json` is unparseable and quarantines it,
  // any subsequent `save()` on this persistence instance must be refused.
  // The registry's persistDisabled flag covers the normal mutation path,
  // but a future caller that holds the persistence reference directly
  // (e.g. a refactor, a script, a stray test) would otherwise race-write
  // a fresh empty file on top of the just-renamed `.bak`. This per-instance
  // latch is the second line of defense.
  let quarantineActive = false;
  let quarantineHealth: PersistenceLoadHealth | null = null;
  let activeBackend: PersistenceBackend = null;

  const persistence: AccountPersistence = {
    load() {
      // Migrate from legacy auth.json if needed
      const migrated = migrateFromLegacy();

      const sqliteFile = getAccountsSqliteFile();
      let sqliteLoadError: unknown = null;
      if (existsSync(sqliteFile)) {
        const sqliteLoad = loadSqlitePersisted(sqliteFile);
        if (sqliteLoad.ok) {
          if (sqliteLoad.entries.length > 0 || !existsSync(getAccountsFile())) {
            activeBackend = "sqlite";
            if (sqliteLoad.needsPersist) {
              persistence.save(sqliteLoad.entries);
            }
            return {
              entries: sqliteLoad.entries,
              needsPersist: sqliteLoad.needsPersist,
            };
          }

          const jsonLoad = loadJsonOrQuarantine();
          if (jsonLoad.loadFailed) return jsonLoad;
          if (jsonLoad.entries.length > 0) {
            if (tryPromoteJsonToSqlite(jsonLoad.entries)) {
              activeBackend = "sqlite";
              if (jsonLoad.needsPersist) {
                trySaveJsonMirror(jsonLoad.entries);
              }
            } else {
              activeBackend = "json";
              if (jsonLoad.needsPersist) {
                trySaveJsonMirror(jsonLoad.entries);
              }
            }
            return jsonLoad;
          }

          activeBackend = "sqlite";
          return { entries: [], needsPersist: false };
        }

        sqliteLoadError = sqliteLoad.error;
        console.warn(
          "[AccountPool] Failed to load accounts.sqlite; falling back to accounts.json:",
          sqliteLoad.error instanceof Error ? sqliteLoad.error.message : sqliteLoad.error,
        );
      }

      const jsonLoad = loadJsonOrQuarantine();
      if (jsonLoad.loadFailed) return jsonLoad;

      const entries = migrated.length > 0 && jsonLoad.entries.length === 0
        ? migrated
        : jsonLoad.entries;

      if (sqliteLoadError != null && entries.length === 0) {
        const failed = quarantineCorruptFile(sqliteFile, null, sqliteLoadError, "sqlite_load_failed");
        quarantineActive = true;
        quarantineHealth = failed.health;
        activeBackend = "sqlite";
        return failed;
      }

      if (entries.length > 0) {
        if (tryPromoteJsonToSqlite(entries)) {
          activeBackend = "sqlite";
          if (jsonLoad.needsPersist) {
            trySaveJsonMirror(entries);
          }
        } else {
          activeBackend = "json";
          if (jsonLoad.needsPersist) {
            trySaveJsonMirror(entries);
          }
        }
        return { entries, needsPersist: jsonLoad.needsPersist };
      }

      activeBackend = "sqlite";
      return { entries, needsPersist: jsonLoad.needsPersist };

      function loadJsonOrQuarantine(): PersistenceLoadResult {
        const loaded = loadPersisted();
        if (loaded.loadFailed) {
          quarantineActive = true;
          quarantineHealth = loaded.health ?? { quarantined: false, backupPath: null };
          activeBackend = "json";
        }
        return loaded;
      }
    },

    save(accounts: AccountEntry[]): void {
      if (quarantineActive) {
        const store = quarantineHealth?.store ?? "accounts.json";
        console.warn(
          `[AccountPool] save() refused: ${store} was quarantined this session` +
            (quarantineHealth?.backupPath ? ` (backup: ${quarantineHealth.backupPath})` : "") +
            ". Restore a healthy file and restart the process to resume auto-save.",
        );
        return;
      }

      if (activeBackend !== "json") {
        try {
          saveSqliteAccounts(getAccountsSqliteFile(), accounts);
          activeBackend = "sqlite";
          trySaveJsonMirror(accounts);
          return;
        } catch (err) {
          console.warn(
            "[AccountPool] Failed to persist accounts.sqlite; falling back to accounts.json:",
            err instanceof Error ? err.message : err,
          );
          activeBackend = "json";
        }
      }

      trySaveJsonMirror(accounts);
    },

    readRefreshToken(entryId: string): string | null {
      if (activeBackend === "json") {
        return readJsonRefreshToken(entryId);
      }

      const sqliteFile = getAccountsSqliteFile();
      if (existsSync(sqliteFile)) {
        const sqliteResult = readSqliteRefreshToken(sqliteFile, entryId);
        if (sqliteResult.ok) return sqliteResult.value;
        console.warn(
          "[AccountPool] Failed to read refresh token from accounts.sqlite; falling back to accounts.json:",
          sqliteResult.error instanceof Error ? sqliteResult.error.message : sqliteResult.error,
        );
      }

      return readJsonRefreshToken(entryId);
    },
  };
  return persistence;
}

function tryPromoteJsonToSqlite(entries: AccountEntry[]): boolean {
  try {
    saveSqliteAccounts(getAccountsSqliteFile(), entries);
    return true;
  } catch (err) {
    console.warn(
      "[AccountPool] Failed to migrate accounts.json to accounts.sqlite; continuing with JSON persistence:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

function trySaveJsonMirror(accounts: AccountEntry[]): void {
  try {
    saveJsonAccounts(accounts);
  } catch (err) {
    console.error("[AccountPool] Failed to persist accounts.json:", err instanceof Error ? err.message : err);
  }
}

function saveJsonAccounts(accounts: AccountEntry[]): void {
  const accountsFile = getAccountsFile();
  const dir = dirname(accountsFile);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const data: AccountsFile = { accounts };
  const tmpFile = accountsFile + ".tmp";
  writeFileSync(tmpFile, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmpFile, accountsFile);
}

function loadSqliteConstructor(): SqliteDatabaseConstructor {
  const nodeSqlite = loadNodeSqliteConstructor();
  if (nodeSqlite) return nodeSqlite;

  const loaded = require("better-sqlite3") as unknown;
  if (typeof loaded !== "function") {
    throw new Error("better-sqlite3 did not export a database constructor");
  }
  return loaded as SqliteDatabaseConstructor;
}

function loadNodeSqliteConstructor(): SqliteDatabaseConstructor | null {
  try {
    const loaded = require("node:sqlite") as unknown;
    if (isNodeSqliteModule(loaded)) {
      return loaded.DatabaseSync;
    }
  } catch {
    return null;
  }
  return null;
}

function isNodeSqliteModule(value: unknown): value is { DatabaseSync: SqliteDatabaseConstructor } {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { DatabaseSync?: unknown }).DatabaseSync === "function"
  );
}

function openSqliteDatabase(sqliteFile: string): SqliteDatabase {
  const Database = loadSqliteConstructor();
  return new Database(sqliteFile);
}

function initSqliteSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      refresh_token TEXT,
      email TEXT,
      account_id TEXT,
      user_id TEXT,
      label TEXT,
      plan_type TEXT,
      proxy_api_key TEXT NOT NULL,
      status TEXT NOT NULL,
      entry_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.exec("PRAGMA user_version = 1");
}

function saveSqliteAccounts(sqliteFile: string, accounts: AccountEntry[]): void {
  const dir = dirname(sqliteFile);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const db = openSqliteDatabase(sqliteFile);
  try {
    initSqliteSchema(db);
    const deleteAll = db.prepare("DELETE FROM accounts");
    const insert = db.prepare(`
      INSERT INTO accounts (
        id,
        token,
        refresh_token,
        email,
        account_id,
        user_id,
        label,
        plan_type,
        proxy_api_key,
        status,
        entry_json,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    db.exec("BEGIN IMMEDIATE");
    try {
      deleteAll.run();
      const updatedAt = new Date().toISOString();
      for (const entry of accounts) {
        insert.run(
          entry.id,
          entry.token,
          entry.refreshToken ?? null,
          entry.email ?? null,
          entry.accountId ?? null,
          entry.userId ?? null,
          entry.label ?? null,
          entry.planType ?? null,
          entry.proxyApiKey,
          entry.status,
          JSON.stringify(entry),
          updatedAt,
        );
      }
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Ignore rollback failures; rethrow the original write error.
      }
      throw err;
    }
  } finally {
    db.close();
  }
}

function loadSqlitePersisted(sqliteFile: string): SqliteLoadResult {
  try {
    const db = openSqliteDatabase(sqliteFile);
    try {
      initSqliteSchema(db);
      const rows = db.prepare("SELECT entry_json FROM accounts ORDER BY rowid").all();
      const rawEntries = rows.map((row) => {
        if (!isAccountSqliteRow(row)) {
          throw new Error("accounts.sqlite row is missing entry_json");
        }
        return JSON.parse(row.entry_json) as unknown;
      });
      const normalized = normalizeAccountEntries(rawEntries);
      return { ok: true, ...normalized };
    } finally {
      db.close();
    }
  } catch (error) {
    return { ok: false, error };
  }
}

function readSqliteRefreshToken(sqliteFile: string, entryId: string): SqliteRefreshTokenResult {
  try {
    const db = openSqliteDatabase(sqliteFile);
    try {
      initSqliteSchema(db);
      const rows = db
        .prepare("SELECT refresh_token FROM accounts WHERE id = ? LIMIT 1")
        .all(entryId);
      if (rows.length === 0) return { ok: true, value: null };
      const row = rows[0];
      if (row === null || typeof row !== "object" || Array.isArray(row)) {
        throw new Error("accounts.sqlite refresh token row is not an object");
      }
      const refreshToken = (row as { refresh_token?: unknown }).refresh_token;
      if (refreshToken !== null && refreshToken !== undefined && typeof refreshToken !== "string") {
        throw new Error("accounts.sqlite refresh_token is not a string or null");
      }
      return { ok: true, value: refreshToken ?? null };
    } finally {
      db.close();
    }
  } catch (error) {
    return { ok: false, error };
  }
}

function readJsonRefreshToken(entryId: string): string | null {
  try {
    const raw = readFileSync(getAccountsFile(), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const accounts = (parsed as { accounts?: unknown }).accounts;
    if (!Array.isArray(accounts)) return null;
    for (const account of accounts) {
      if (account === null || typeof account !== "object" || Array.isArray(account)) continue;
      const record = account as { id?: unknown; refreshToken?: unknown };
      if (record.id === entryId) {
        return typeof record.refreshToken === "string" ? record.refreshToken : null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function isAccountSqliteRow(value: unknown): value is { entry_json: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { entry_json?: unknown }).entry_json === "string"
  );
}

function normalizeAccountEntries(rawEntries: unknown[]): {
  entries: AccountEntry[];
  needsPersist: boolean;
} {
  const entries: AccountEntry[] = [];
  let needsPersist = false;

  for (const rawEntry of rawEntries) {
    if (rawEntry === null || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
      continue;
    }
    const entry = rawEntry as AccountEntry;
    if (!entry.id || !entry.token) continue;

    if (entry.refreshToken === undefined) {
      entry.refreshToken = null;
      needsPersist = true;
    }

    // Backfill missing fields from JWT
    if (!entry.planType || !entry.email || !entry.accountId || !entry.userId) {
      const profile = extractUserProfile(entry.token);
      const accountId = extractChatGptAccountId(entry.token);
      if (!entry.planType && profile?.chatgpt_plan_type) {
        entry.planType = profile.chatgpt_plan_type;
        needsPersist = true;
      }
      if (!entry.email && profile?.email) {
        entry.email = profile.email;
        needsPersist = true;
      }
      if (!entry.accountId && accountId) {
        entry.accountId = accountId;
        needsPersist = true;
      }
      if (!entry.userId && profile?.chatgpt_user_id) {
        entry.userId = profile.chatgpt_user_id;
        needsPersist = true;
      }
    }
    if (entry.email === undefined) {
      entry.email = null;
      needsPersist = true;
    }
    if (entry.accountId === undefined) {
      entry.accountId = null;
      needsPersist = true;
    }
    // Backfill userId for entries missing it (pre-v1.0.68)
    if (entry.userId === undefined) {
      entry.userId = null;
      needsPersist = true;
    }
    if (entry.planType === undefined) {
      entry.planType = null;
      needsPersist = true;
    }
    // Backfill empty_response_count
    if (entry.usage.empty_response_count == null) {
      entry.usage.empty_response_count = 0;
      needsPersist = true;
    }
    // Backfill window counter fields
    if (entry.usage.window_request_count == null) {
      entry.usage.window_request_count = 0;
      entry.usage.window_input_tokens = 0;
      entry.usage.window_output_tokens = 0;
      entry.usage.window_counters_reset_at = null;
      entry.usage.limit_window_seconds = null;
      needsPersist = true;
    }
    // Backfill cached_tokens fields (added in cache-hit-rate stats)
    if (entry.usage.cached_tokens == null) {
      entry.usage.cached_tokens = 0;
      needsPersist = true;
    }
    if (entry.usage.window_cached_tokens == null) {
      entry.usage.window_cached_tokens = 0;
      needsPersist = true;
    }
    // Backfill window_reset_at (missing causes NaN in refreshStatus)
    if (!("window_reset_at" in entry.usage)) {
      entry.usage.window_reset_at = null;
      needsPersist = true;
    }
    // Backfill label field
    if ((entry as unknown as Record<string, unknown>).label === undefined) {
      entry.label = null;
      needsPersist = true;
    }
    // Fingerprint convergence is always explicit opt-in. Missing or invalid
    // persisted values must remain off to avoid silently changing identity.
    if (entry.codexFingerprintMode !== "session" && entry.codexFingerprintMode !== "off") {
      entry.codexFingerprintMode = "off";
      needsPersist = true;
    }
    // Backfill cachedQuota fields
    if (entry.cachedQuota === undefined) {
      entry.cachedQuota = null;
      entry.quotaFetchedAt = null;
      needsPersist = true;
    }
    if (entry.quotaFetchedAt === undefined) {
      entry.quotaFetchedAt = null;
      needsPersist = true;
    }
    // Backfill quotaVerifyRequired (added in cascading-ban-defense)
    // If absent (pre-existing disk entry), default to false so old entries
    // don't trigger unnecessary upstream verification.
    if (entry.quotaVerifyRequired === undefined) {
      entry.quotaVerifyRequired = false;
      needsPersist = true;
    }
    // Migrate legacy rate_limit_until + status="rate_limited" → cachedQuota
    if (migrateLegacyRateLimit(entry)) {
      needsPersist = true;
    }
    entries.push(entry);
  }

  return { entries, needsPersist };
}

function migrateFromLegacy(): AccountEntry[] {
  try {
    const accountsFile = getAccountsFile();
    const legacyAuthFile = getLegacyAuthFile();
    if (existsSync(accountsFile)) return []; // already migrated
    if (!existsSync(legacyAuthFile)) return [];

    const raw = readFileSync(legacyAuthFile, "utf-8");
    const data = JSON.parse(raw) as {
      token: string;
      proxyApiKey?: string | null;
      userInfo?: { email?: string; accountId?: string; planType?: string } | null;
    };

    if (!data.token) return [];

    const id = randomBytes(8).toString("hex");
    const accountId = extractChatGptAccountId(data.token);
    const entry: AccountEntry = {
      id,
      token: data.token,
      refreshToken: null,
      email: data.userInfo?.email ?? null,
      accountId: accountId,
      userId: extractUserProfile(data.token)?.chatgpt_user_id ?? null,
      label: null,
      codexFingerprintMode: "off",
      planType: data.userInfo?.planType ?? null,
      proxyApiKey: data.proxyApiKey ?? "codex-proxy-" + randomBytes(24).toString("hex"),
      status: isTokenExpired(data.token) ? "expired" : "active",
      usage: {
        request_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cached_tokens: 0,
        empty_response_count: 0,
        last_used: null,
        rate_limit_until: null,
        window_request_count: 0,
        window_input_tokens: 0,
        window_output_tokens: 0,
        window_cached_tokens: 0,
        window_counters_reset_at: null,
        limit_window_seconds: null,
      },
      addedAt: new Date().toISOString(),
      cachedQuota: null,
      quotaFetchedAt: null,
    };

    // Write new format
    const dir = dirname(accountsFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const accountsData: AccountsFile = { accounts: [entry] };
    writeFileSync(accountsFile, JSON.stringify(accountsData, null, 2), "utf-8");

    // Rename old file
    renameSync(legacyAuthFile, legacyAuthFile + ".bak");
    console.log("[AccountPool] Migrated from auth.json → accounts.json");
    return [entry];
  } catch (err) {
    console.warn("[AccountPool] Migration failed:", err);
    return [];
  }
}

function loadPersisted(): PersistenceLoadResult {
  const accountsFile = getAccountsFile();
  if (!existsSync(accountsFile)) return { entries: [], needsPersist: false };

  let raw: string;
  try {
    raw = readFileSync(accountsFile, "utf-8");
  } catch (err) {
    return quarantineCorruptFile(accountsFile, null, err, "read_failed");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return quarantineCorruptFile(accountsFile, raw, err, "json_parse_failed");
  }

  // Validate shape BEFORE reading `.accounts` — `null`, primitives, or
  // arrays at the top level would otherwise crash on property access or
  // pass an Array.isArray check on the wrong target.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return quarantineCorruptFile(
      accountsFile,
      raw,
      new Error(`top-level JSON is not an object (got ${parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed})`),
      "shape_invalid",
    );
  }

  const data = parsed as AccountsFile;
  if (!Array.isArray(data.accounts)) {
    return quarantineCorruptFile(
      accountsFile,
      raw,
      new Error("accounts field is not an array"),
      "shape_invalid",
    );
  }

  try {
    return normalizeAccountEntries(data.accounts);
  } catch (err) {
    // The per-entry migration/backfill loop threw. Treat as corruption.
    return quarantineCorruptFile(accountsFile, raw, err, "entry_processing_failed");
  }
}

/**
 * Move the unparseable `accounts.json` aside so the next launch can start
 * cleanly, and surface the failure via the local error log. The caller
 * (AccountPool) reads `loadFailed=true` and flips the registry into a
 * persist-disabled state so we don't overwrite the quarantine with the
 * empty in-memory map.
 *
 * Renaming is best-effort: filesystem quirks (lock, permission) must not
 * prevent the caller from getting a `loadFailed` signal. If rename fails,
 * the original file stays on disk and the next launch will hit the same
 * code path — still better than silent data loss.
 */
function quarantineCorruptFile(
  accountsFile: string,
  rawContent: string | null,
  err: unknown,
  reason: string,
): {
  entries: AccountEntry[];
  needsPersist: boolean;
  loadFailed: true;
  health: PersistenceLoadHealth;
} {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${accountsFile}.corrupt-${stamp}.bak`;
  let quarantined = false;
  let renameError: unknown = null;
  try {
    renameSync(accountsFile, backupPath);
    quarantined = true;
  } catch (renameErr) {
    renameError = renameErr;
  }

  const message = err instanceof Error ? err.message : String(err);
  console.warn(
    `[AccountPool] Failed to load accounts (${reason}): ${message}. ` +
      (quarantined
        ? `Quarantined original to ${backupPath}.`
        : `Quarantine rename failed; original file left in place.`),
  );

  try {
    appendErrorLog({
      source: "server",
      error: {
        name: "AccountsFileLoadFailed",
        message,
        stack: err instanceof Error ? err.stack : undefined,
      },
      context: {
        reason,
        accountsFile,
        quarantined,
        backupPath: quarantined ? backupPath : null,
        renameError:
          renameError instanceof Error ? renameError.message : renameError ? String(renameError) : null,
        rawByteLength: rawContent != null ? Buffer.byteLength(rawContent, "utf-8") : null,
      },
    });
  } catch {
    // appendErrorLog already swallows write failures, but guard against
    // upstream-side throws (e.g. getConfig() unavailable in early boot).
  }

  return {
    entries: [],
    needsPersist: false,
    loadFailed: true,
    health: {
      quarantined,
      backupPath: quarantined ? backupPath : null,
      store: accountsFile.endsWith(".sqlite") ? "accounts.sqlite" : "accounts.json",
    },
  };
}
