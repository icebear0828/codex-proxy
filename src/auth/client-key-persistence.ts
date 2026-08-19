import Database from "better-sqlite3";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { getDataDir } from "../paths.js";
import type { ClientKeyEntry } from "./client-key-types.js";

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
  private db: Database.Database | null = null;

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

  private initSqlite(): Database.Database {
    if (this.db) return this.db;
    this.ensureDir(this.sqlitePath);
    const db = new Database(this.sqlitePath);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");

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
  }

  public load(): ClientKeyEntry[] {
    // 1. Try SQLite
    try {
      const db = this.initSqlite();
      const rows = db.prepare("SELECT * FROM client_keys").all() as ClientKeyRow[];
      return rows.map((r) => this.rowToEntry(r));
    } catch (sqliteErr) {
      console.warn(`[ClientKeyPersistence] SQLite load failed, attempting JSON fallback: ${sqliteErr}`);
    }

    // 2. Try JSON fallback
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
    // Save to SQLite transaction
    const db = this.initSqlite();
    const deleteStmt = db.prepare("DELETE FROM client_keys");
    const insertStmt = db.prepare(`
      INSERT INTO client_keys (
        id, name, key, status, expires_at, max_budget_usd, used_cost_usd,
        max_tokens, used_tokens, max_concurrency, allowed_models, default_tools,
        request_count, last_used_at, created_at, updated_at
      ) VALUES (
        @id, @name, @key, @status, @expires_at, @max_budget_usd, @used_cost_usd,
        @max_tokens, @used_tokens, @max_concurrency, @allowed_models, @default_tools,
        @request_count, @last_used_at, @created_at, @updated_at
      )
    `);

    const saveTx = db.transaction((entries: ClientKeyEntry[]) => {
      deleteStmt.run();
      for (const entry of entries) {
        insertStmt.run(this.entryToRow(entry));
      }
    });

    saveTx(keys);

    // Save JSON mirror backup
    this.ensureDir(this.jsonPath);
    writeFileSync(this.jsonPath, JSON.stringify(keys, null, 2), "utf-8");
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
      allowed_models: row.allowed_models ? (JSON.parse(row.allowed_models) as string[]) : null,
      default_tools: row.default_tools ? (JSON.parse(row.default_tools) as string[]) : null,
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
