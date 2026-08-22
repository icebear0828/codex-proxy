import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { createRequire } from "module";
import { getDataDir } from "../paths.js";
import type { ClientKeyEntry } from "./client-key-types.js";

const require = createRequire(import.meta.url);

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

type SqliteDatabaseConstructor = new (filename: string) => SqliteDatabase;

function isNodeSqliteModule(value: unknown): value is { DatabaseSync: SqliteDatabaseConstructor } {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { DatabaseSync?: unknown }).DatabaseSync === "function"
  );
}

function loadSqliteConstructor(): SqliteDatabaseConstructor | null {
  try {
    const loaded = require("node:sqlite") as unknown;
    if (isNodeSqliteModule(loaded)) {
      return loaded.DatabaseSync;
    }
  } catch {
    // node:sqlite not available, try better-sqlite3
  }

  try {
    const loaded = require("better-sqlite3") as unknown;
    if (typeof loaded === "function") {
      return loaded as SqliteDatabaseConstructor;
    }
  } catch {
    // better-sqlite3 not available
  }

  return null;
}

interface ClientKeyRow {
  id: string;
  name: string;
  key: string;
  status: string;
  expires_at: string | null;
  max_budget_usd: number | null;
  used_cost_usd: number;
  max_tokens: number | null;
  used_tokens: number;
  max_concurrency: number | null;
  allowed_models: string | null;
  default_tools: string | null;
  request_count: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export class ClientKeyPersistence {
  private sqlitePath: string;
  private jsonPath: string;
  private db: SqliteDatabase | null = null;
  private sqliteFailed = false;

  constructor(sqlitePath?: string, jsonPath?: string) {
    const dataDir = getDataDir();
    this.sqlitePath = sqlitePath ?? `${dataDir}/client-keys.sqlite`;
    this.jsonPath = jsonPath ?? `${dataDir}/client-keys.json`;
  }

  private ensureDir(filePath: string): void {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  private initSqlite(): SqliteDatabase | null {
    if (this.sqliteFailed) return null;
    if (this.db) return this.db;

    const SqliteCtor = loadSqliteConstructor();
    if (!SqliteCtor) {
      this.sqliteFailed = true;
      return null;
    }

    try {
      this.ensureDir(this.sqlitePath);
      const db = new SqliteCtor(this.sqlitePath);
      try {
        db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
      } catch {
        // pragma might be unsupported in certain drivers
      }

      db.exec(`
        CREATE TABLE IF NOT EXISTS client_keys (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          key TEXT UNIQUE NOT NULL,
          status TEXT NOT NULL,
          expires_at TEXT,
          max_budget_usd REAL,
          used_cost_usd REAL NOT NULL DEFAULT 0,
          max_tokens INTEGER,
          used_tokens INTEGER NOT NULL DEFAULT 0,
          max_concurrency INTEGER,
          allowed_models TEXT,
          default_tools TEXT,
          request_count INTEGER NOT NULL DEFAULT 0,
          last_used_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_client_keys_key ON client_keys(key);
        CREATE INDEX IF NOT EXISTS idx_client_keys_status ON client_keys(status);
      `);

      try {
        db.exec("ALTER TABLE client_keys ADD COLUMN default_tools TEXT");
      } catch {
        // Column already exists
      }

      this.db = db;
      return db;
    } catch (err) {
      this.sqliteFailed = true;
      console.warn(`[ClientKeyPersistence] Failed to initialize SQLite database: ${err}`);
      return null;
    }
  }

  public load(): ClientKeyEntry[] {
    // 1. Try SQLite
    try {
      const db = this.initSqlite();
      if (db) {
        const rows = db.prepare("SELECT * FROM client_keys").all() as ClientKeyRow[];
        if (rows.length > 0) {
          return rows.map((r) => this.rowToEntry(r));
        }

        // If SQLite is empty, check if we have existing keys in JSON backup to migrate
        if (existsSync(this.jsonPath)) {
          const jsonEntries = this.loadJsonFallback();
          if (jsonEntries.length > 0) {
            console.log(`[ClientKeyPersistence] Migrating ${jsonEntries.length} client key(s) from JSON to SQLite`);
            try {
              this.save(jsonEntries);
            } catch (saveErr) {
              console.warn(`[ClientKeyPersistence] Failed to seed SQLite from JSON: ${saveErr}`);
            }
            return jsonEntries;
          }
        }

        return [];
      }
    } catch (sqliteErr) {
      console.warn(`[ClientKeyPersistence] SQLite load failed, attempting JSON fallback: ${sqliteErr}`);
    }

    // 2. Try JSON fallback
    return this.loadJsonFallback();
  }

  private loadJsonFallback(): ClientKeyEntry[] {
    try {
      if (existsSync(this.jsonPath)) {
        const raw = readFileSync(this.jsonPath, "utf-8");
        const parsed = JSON.parse(raw) as ClientKeyEntry[];
        if (Array.isArray(parsed)) {
          console.log(`[ClientKeyPersistence] Successfully recovered ${parsed.length} client key(s) from JSON backup`);
          return parsed;
        }
      }
    } catch (jsonErr) {
      console.error(`[ClientKeyPersistence] JSON fallback load failed: ${jsonErr}`);
    }
    return [];
  }

  public save(keys: ClientKeyEntry[]): void {
    // 1. Try SQLite transaction
    let sqliteSaved = false;
    try {
      const db = this.initSqlite();
      if (db) {
        const deleteStmt = db.prepare("DELETE FROM client_keys");
        const insertStmt = db.prepare(`
          INSERT INTO client_keys (
            id, name, key, status, expires_at, max_budget_usd, used_cost_usd,
            max_tokens, used_tokens, max_concurrency, allowed_models, default_tools,
            request_count, last_used_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        db.exec("BEGIN IMMEDIATE");
        try {
          deleteStmt.run();
          for (const entry of keys) {
            const row = this.entryToRow(entry);
            insertStmt.run(
              row.id,
              row.name,
              row.key,
              row.status,
              row.expires_at,
              row.max_budget_usd,
              row.used_cost_usd,
              row.max_tokens,
              row.used_tokens,
              row.max_concurrency,
              row.allowed_models,
              row.default_tools,
              row.request_count,
              row.last_used_at,
              row.created_at,
              row.updated_at,
            );
          }
          db.exec("COMMIT");
          sqliteSaved = true;
        } catch (txErr) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // ignore rollback error
          }
          throw txErr;
        }
      }
    } catch (sqliteErr) {
      this.sqliteFailed = true;
      this.db = null;
      console.warn(`[ClientKeyPersistence] SQLite save failed, falling back to JSON: ${sqliteErr}`);
    }

    // 2. Save JSON mirror backup (or primary store if SQLite failed)
    try {
      this.ensureDir(this.jsonPath);
      writeFileSync(this.jsonPath, JSON.stringify(keys, null, 2), "utf-8");
    } catch (jsonErr) {
      if (!sqliteSaved) {
        throw new Error(`Failed to save client keys to both SQLite and JSON: ${jsonErr}`);
      }
      console.error(`[ClientKeyPersistence] JSON mirror backup save failed: ${jsonErr}`);
    }
  }

  private safeJsonParse<T>(val: string | null): T | null {
    if (!val) return null;
    try {
      return JSON.parse(val) as T;
    } catch {
      return null;
    }
  }

  private rowToEntry(row: ClientKeyRow): ClientKeyEntry {
    return {
      id: row.id,
      name: row.name,
      key: row.key,
      status: row.status as "active" | "disabled",
      expires_at: row.expires_at,
      max_budget_usd: row.max_budget_usd,
      used_cost_usd: row.used_cost_usd,
      max_tokens: row.max_tokens,
      used_tokens: row.used_tokens,
      max_concurrency: row.max_concurrency,
      allowed_models: this.safeJsonParse<string[]>(row.allowed_models),
      default_tools: this.safeJsonParse<string[]>(row.default_tools),
      request_count: row.request_count,
      last_used_at: row.last_used_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private entryToRow(entry: ClientKeyEntry): ClientKeyRow {
    return {
      id: entry.id,
      name: entry.name,
      key: entry.key,
      status: entry.status,
      expires_at: entry.expires_at,
      max_budget_usd: entry.max_budget_usd,
      used_cost_usd: entry.used_cost_usd,
      max_tokens: entry.max_tokens,
      used_tokens: entry.used_tokens,
      max_concurrency: entry.max_concurrency,
      allowed_models: entry.allowed_models ? JSON.stringify(entry.allowed_models) : null,
      default_tools: entry.default_tools ? JSON.stringify(entry.default_tools) : null,
      request_count: entry.request_count,
      last_used_at: entry.last_used_at,
      created_at: entry.created_at,
      updated_at: entry.updated_at,
    };
  }
}

