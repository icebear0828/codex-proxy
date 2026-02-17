import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { randomBytes } from "crypto";
import { getConfig } from "../config.js";
import {
  decodeJwtPayload,
  extractChatGptAccountId,
  extractUserProfile,
  isTokenExpired,
} from "./jwt-utils.js";

interface PersistedAuth {
  token: string;
  proxyApiKey: string | null;
  userInfo: { email?: string; accountId?: string; planType?: string } | null;
}

const AUTH_FILE = resolve(process.cwd(), "data", "auth.json");

export class AuthManager {
  private token: string | null = null;
  private userInfo: { email?: string; accountId?: string; planType?: string } | null = null;
  private proxyApiKey: string | null = null;
  private refreshLock: Promise<string | null> | null = null;

  constructor() {
    this.loadPersisted();

    // Override with config jwt_token if set
    const config = getConfig();
    if (config.auth.jwt_token) {
      this.setToken(config.auth.jwt_token);
    }

    // Override with env var if set
    const envToken = process.env.CODEX_JWT_TOKEN;
    if (envToken) {
      this.setToken(envToken);
    }
  }

  async getToken(forceRefresh?: boolean): Promise<string | null> {
    if (forceRefresh || (this.token && this.isExpired())) {
      // Use a lock to prevent concurrent refresh attempts
      if (!this.refreshLock) {
        this.refreshLock = this.attemptRefresh();
      }
      try {
        return await this.refreshLock;
      } finally {
        this.refreshLock = null;
      }
    }
    return this.token;
  }

  setToken(token: string): void {
    this.token = token;

    // Extract user info from JWT claims
    const profile = extractUserProfile(token);
    const accountId = extractChatGptAccountId(token);
    this.userInfo = {
      email: profile?.email,
      accountId: accountId ?? undefined,
      planType: profile?.chatgpt_plan_type,
    };

    // Generate proxy API key if we don't have one yet
    if (!this.proxyApiKey) {
      this.proxyApiKey = this.generateApiKey();
    }

    this.persist();
  }

  clearToken(): void {
    this.token = null;
    this.userInfo = null;
    this.proxyApiKey = null;
    try {
      if (existsSync(AUTH_FILE)) {
        unlinkSync(AUTH_FILE);
      }
    } catch {
      // ignore cleanup errors
    }
  }

  isAuthenticated(): boolean {
    return this.token !== null && !this.isExpired();
  }

  getUserInfo(): { email?: string; accountId?: string; planType?: string } | null {
    return this.userInfo;
  }

  getAccountId(): string | null {
    if (!this.token) return null;
    return extractChatGptAccountId(this.token);
  }

  getProxyApiKey(): string | null {
    return this.proxyApiKey;
  }

  validateProxyApiKey(key: string): boolean {
    if (!this.proxyApiKey) return false;
    return key === this.proxyApiKey;
  }

  // --- private helpers ---

  private isExpired(): boolean {
    if (!this.token) return true;
    const config = getConfig();
    return isTokenExpired(this.token, config.auth.refresh_margin_seconds);
  }

  private async attemptRefresh(): Promise<string | null> {
    // We cannot auto-refresh without Codex CLI interaction.
    // If the token is expired, the user needs to re-login.
    if (this.token && isTokenExpired(this.token)) {
      this.token = null;
      this.userInfo = null;
    }
    return this.token;
  }

  private persist(): void {
    try {
      const dir = dirname(AUTH_FILE);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const data: PersistedAuth = {
        token: this.token!,
        proxyApiKey: this.proxyApiKey,
        userInfo: this.userInfo,
      };
      writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2), "utf-8");
    } catch {
      // Persist is best-effort
    }
  }

  private loadPersisted(): void {
    try {
      if (!existsSync(AUTH_FILE)) return;
      const raw = readFileSync(AUTH_FILE, "utf-8");
      const data = JSON.parse(raw) as PersistedAuth;
      if (data.token && typeof data.token === "string") {
        this.token = data.token;
        this.proxyApiKey = data.proxyApiKey ?? null;
        this.userInfo = data.userInfo ?? null;
      }
    } catch {
      // If the file is corrupt, start fresh
    }
  }

  private generateApiKey(): string {
    return "codex-proxy-" + randomBytes(24).toString("hex");
  }
}
