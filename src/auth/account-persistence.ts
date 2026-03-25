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
import { resolve, dirname } from "path";
import { randomBytes } from "crypto";
import { getDataDir } from "../paths.js";
import {
  extractChatGptAccountId,
  extractUserProfile,
  isTokenExpired,
} from "./jwt-utils.js";
import type { AccountEntry, AccountsFile } from "./types.js";

export interface AccountPersistence {
  load(): { entries: AccountEntry[]; needsPersist: boolean };
  save(accounts: AccountEntry[]): void;
}

function getAccountsFile(): string {
  return resolve(getDataDir(), "accounts.json");
}
function getLegacyAuthFile(): string {
  return resolve(getDataDir(), "auth.json");
}

export function createFsPersistence(): AccountPersistence {
  const persistence: AccountPersistence = {
    load(): { entries: AccountEntry[]; needsPersist: boolean } {
      // Migrate from legacy auth.json if needed
      const migrated = migrateFromLegacy();

      // Load from accounts.json
      const { entries: loaded, needsPersist } = loadPersisted();

      const entries = migrated.length > 0 && loaded.length === 0 ? migrated : loaded;

      // Auto-persist when backfill was applied (preserves original behavior)
      if (needsPersist && loaded.length > 0) {
        persistence.save(loaded);
      }

      return { entries, needsPersist };
    },

    save(accounts: AccountEntry[]): void {
      try {
        const accountsFile = getAccountsFile();
        const dir = dirname(accountsFile);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const data: AccountsFile = { accounts };
        const tmpFile = accountsFile + ".tmp";
        writeFileSync(tmpFile, JSON.stringify(data, null, 2), "utf-8");
        renameSync(tmpFile, accountsFile);
      } catch (err) {
        console.error("[AccountPool] Failed to persist accounts:", err instanceof Error ? err.message : err);
      }
    },
  };
  return persistence;
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
      planType: data.userInfo?.planType ?? null,
      proxyApiKey: data.proxyApiKey ?? "codex-proxy-" + randomBytes(24).toString("hex"),
      status: isTokenExpired(data.token) ? "expired" : "active",
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

function loadPersisted(): { entries: AccountEntry[]; needsPersist: boolean } {
  try {
    const accountsFile = getAccountsFile();
    if (!existsSync(accountsFile)) return { entries: [], needsPersist: false };
    const raw = readFileSync(accountsFile, "utf-8");
    const data = JSON.parse(raw) as AccountsFile;
    if (!Array.isArray(data.accounts)) return { entries: [], needsPersist: false };

    const entries: AccountEntry[] = [];
    let needsPersist = false;

    for (const entry of data.accounts) {
      if (!entry.id || !entry.token) continue;

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
      // Backfill userId for entries missing it (pre-v1.0.68)
      if (entry.userId === undefined) {
        entry.userId = null;
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
      // Backfill label field
      if ((entry as unknown as Record<string, unknown>).label === undefined) {
        entry.label = null;
        needsPersist = true;
      }
      // Backfill cachedQuota fields
      if (entry.cachedQuota === undefined) {
        entry.cachedQuota = null;
        entry.quotaFetchedAt = null;
        needsPersist = true;
      }
      entries.push(entry);
    }

    return { entries, needsPersist };
  } catch (err) {
    console.warn("[AccountPool] Failed to load accounts:", err instanceof Error ? err.message : err);
    return { entries: [], needsPersist: false };
  }
}
