/**
 * ProxyPool — per-account proxy management with health checks.
 *
 * Stores proxy entries and account→proxy assignments.
 * Supports manual assignment, "auto" round-robin, "direct" (no proxy),
 * and "global" (use the globally detected proxy).
 *
 * Persistence: data/proxies.json (atomic write via tmp + rename).
 * Health checks: periodic + on-demand, using api.ipify.org for exit IP.
 */

import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdirSync,
} from "fs";
import { resolve, dirname } from "path";
import { getDataDir } from "../paths.js";
import { getTransport } from "../tls/transport.js";

function getProxiesFile(): string {
  return resolve(getDataDir(), "proxies.json");
}

// ── Types ─────────────────────────────────────────────────────────────

export interface ProxyHealthInfo {
  exitIp: string | null;
  latencyMs: number;
  lastChecked: string;
  error: string | null;
}

export type ProxyStatus = "active" | "unreachable" | "disabled";

export interface ProxyEntry {
  id: string;
  name: string;
  url: string;
  status: ProxyStatus;
  health: ProxyHealthInfo | null;
  addedAt: string;
}

/** Special assignment values (not a proxy ID). */
export type SpecialAssignment = "global" | "direct" | "auto";

export interface ProxyAssignment {
  accountId: string;
  proxyId: string; // ProxyEntry.id | SpecialAssignment
}

interface ProxiesFile {
  proxies: ProxyEntry[];
  assignments: ProxyAssignment[];
  healthCheckIntervalMinutes: number;
}

const HEALTH_CHECK_URL = "https://api.ipify.org?format=json";
const DEFAULT_HEALTH_INTERVAL_MIN = 5;

// ── ProxyPool ─────────────────────────────────────────────────────────

export class ProxyPool {
  private proxies: Map<string, ProxyEntry> = new Map();
  private assignments: Map<string, string> = new Map(); // accountId → proxyId
  private healthIntervalMin = DEFAULT_HEALTH_INTERVAL_MIN;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private _roundRobinIndex = 0;

  constructor() {
    this.load();
  }

  // ── CRUD ──────────────────────────────────────────────────────────

  add(name: string, url: string): string {
    const trimmedUrl = url.trim();
    // Reject duplicate URLs
    for (const existing of this.proxies.values()) {
      if (existing.url === trimmedUrl) {
        return existing.id;
      }
    }
    const id = randomHex(8);
    const entry: ProxyEntry = {
      id,
      name: name.trim(),
      url: trimmedUrl,
      status: "active",
      health: null,
      addedAt: new Date().toISOString(),
    };
    this.proxies.set(id, entry);
    this.persistNow();
    return id;
  }

  remove(id: string): boolean {
    if (!this.proxies.delete(id)) return false;
    // Clean up assignments pointing to this proxy
    for (const [accountId, proxyId] of this.assignments) {
      if (proxyId === id) {
        this.assignments.delete(accountId);
      }
    }
    this.persistNow();
    return true;
  }

  update(id: string, fields: { name?: string; url?: string }): boolean {
    const entry = this.proxies.get(id);
    if (!entry) return false;
    if (fields.name !== undefined) entry.name = fields.name.trim();
    if (fields.url !== undefined) {
      entry.url = fields.url.trim();
      entry.health = null; // reset health on URL change
      entry.status = "active";
    }
    this.schedulePersist();
    return true;
  }

  getAll(): ProxyEntry[] {
    return Array.from(this.proxies.values());
  }

  /** Returns all proxies with credentials masked in URLs. */
  getAllMasked(): ProxyEntry[] {
    return this.getAll().map((p) => ({ ...p, url: maskProxyUrl(p.url) }));
  }

  getById(id: string): ProxyEntry | undefined {
    return this.proxies.get(id);
  }

  enable(id: string): boolean {
    const entry = this.proxies.get(id);
    if (!entry) return false;
    entry.status = "active";
    this.schedulePersist();
    return true;
  }

  disable(id: string): boolean {
    const entry = this.proxies.get(id);
    if (!entry) return false;
    entry.status = "disabled";
    this.schedulePersist();
    return true;
  }

  // ── Assignment ────────────────────────────────────────────────────

  assign(accountId: string, proxyId: string): void {
    this.assignments.set(accountId, proxyId);
    this.persistNow();
  }

  bulkAssign(assignments: Array<{ accountId: string; proxyId: string }>): void {
    for (const { accountId, proxyId } of assignments) {
      this.assignments.set(accountId, proxyId);
    }
    this.persistNow();
  }

  unassign(accountId: string): void {
    if (this.assignments.delete(accountId)) {
      this.persistNow();
    }
  }

  getAssignment(accountId: string): string {
    return this.assignments.get(accountId) ?? "global";
  }

  getAllAssignments(): ProxyAssignment[] {
    const result: ProxyAssignment[] = [];
    for (const [accountId, proxyId] of this.assignments) {
      result.push({ accountId, proxyId });
    }
    return result;
  }

  /**
   * Get display name for an assignment.
   */
  getAssignmentDisplayName(accountId: string): string {
    const assignment = this.getAssignment(accountId);
    if (assignment === "global") return "Global Default";
    if (assignment === "direct") return "Direct (No Proxy)";
    if (assignment === "auto") return "Auto (Round-Robin)";
    const proxy = this.proxies.get(assignment);
    return proxy ? proxy.name : "Unknown Proxy";
  }

  // ── Resolution ────────────────────────────────────────────────────

  /**
   * Resolve the proxy URL for an account.
   * Returns:
   *   undefined — use global proxy (default behavior)
   *   null     — direct connection (no proxy)
   *   string   — specific proxy URL
   */
  resolveProxyUrl(accountId: string): string | null | undefined {
    const assignment = this.getAssignment(accountId);

    if (assignment === "global") return undefined;
    if (assignment === "direct") return null;

    if (assignment === "auto") {
      return this.pickRoundRobin();
    }

    // Specific proxy ID
    const proxy = this.proxies.get(assignment);
    if (!proxy || proxy.status !== "active") {
      // Proxy deleted or unreachable/disabled — fall back to global
      return undefined;
    }
    return proxy.url;
  }

  /**
   * Round-robin pick from active proxies.
   * Returns undefined (global) if no active proxies exist.
   */
  private pickRoundRobin(): string | undefined {
    const active = Array.from(this.proxies.values()).filter(
      (p) => p.status === "active",
    );
    if (active.length === 0) return undefined;

    this._roundRobinIndex = this._roundRobinIndex % active.length;
    const picked = active[this._roundRobinIndex];
    this._roundRobinIndex = (this._roundRobinIndex + 1) % active.length;
    return picked.url;
  }

  // ── Health Check ──────────────────────────────────────────────────

  async healthCheck(id: string): Promise<ProxyHealthInfo> {
    const proxy = this.proxies.get(id);
    if (!proxy) {
      throw new Error(`Proxy ${id} not found`);
    }

    const transport = getTransport();
    const start = Date.now();

    try {
      const result = await transport.get(
        HEALTH_CHECK_URL,
        { Accept: "application/json" },
        10,
        proxy.url,
      );
      const latencyMs = Date.now() - start;

      let exitIp: string | null = null;
      try {
        const parsed = JSON.parse(result.body) as { ip?: string };
        exitIp = parsed.ip ?? null;
      } catch {
        // Could not parse IP
      }

      const info: ProxyHealthInfo = {
        exitIp,
        latencyMs,
        lastChecked: new Date().toISOString(),
        error: null,
      };

      proxy.health = info;
      // Only change status if not manually disabled
      if (proxy.status !== "disabled") {
        proxy.status = "active";
      }
      this.schedulePersist();
      return info;
    } catch (err) {
      const latencyMs = Date.now() - start;
      const error = err instanceof Error ? err.message : String(err);

      const info: ProxyHealthInfo = {
        exitIp: null,
        latencyMs,
        lastChecked: new Date().toISOString(),
        error,
      };

      proxy.health = info;
      if (proxy.status !== "disabled") {
        proxy.status = "unreachable";
      }
      this.schedulePersist();
      return info;
    }
  }

  async healthCheckAll(): Promise<void> {
    const targets = Array.from(this.proxies.values()).filter(
      (p) => p.status !== "disabled",
    );
    if (targets.length === 0) return;

    console.log(`[ProxyPool] Health checking ${targets.length} proxies...`);
    await Promise.allSettled(targets.map((p) => this.healthCheck(p.id)));

    const active = targets.filter((p) => p.status === "active").length;
    console.log(
      `[ProxyPool] Health check complete: ${active}/${targets.length} active`,
    );
  }

  startHealthCheckTimer(): void {
    this.stopHealthCheckTimer();
    if (this.proxies.size === 0) return;

    const intervalMs = this.healthIntervalMin * 60 * 1000;
    this.healthTimer = setInterval(() => {
      this.healthCheckAll().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[ProxyPool] Periodic health check error: ${msg}`);
      });
    }, intervalMs);
    if (this.healthTimer.unref) this.healthTimer.unref();

    console.log(
      `[ProxyPool] Health check timer started (every ${this.healthIntervalMin}min)`,
    );
  }

  stopHealthCheckTimer(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  getHealthIntervalMinutes(): number {
    return this.healthIntervalMin;
  }

  setHealthIntervalMinutes(minutes: number): void {
    this.healthIntervalMin = Math.max(1, minutes);
    this.schedulePersist();
    // Restart timer with new interval
    if (this.healthTimer) {
      this.startHealthCheckTimer();
    }
  }

  // ── Persistence ───────────────────────────────────────────────────

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistNow();
    }, 1000);
  }

  persistNow(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    try {
      const filePath = getProxiesFile();
      const dir = dirname(filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      const data: ProxiesFile = {
        proxies: Array.from(this.proxies.values()),
        assignments: this.getAllAssignments(),
        healthCheckIntervalMinutes: this.healthIntervalMin,
      };

      const tmpFile = filePath + ".tmp";
      writeFileSync(tmpFile, JSON.stringify(data, null, 2), "utf-8");
      renameSync(tmpFile, filePath);
    } catch (err) {
      console.warn(
        "[ProxyPool] Failed to persist:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  private load(): void {
    try {
      const filePath = getProxiesFile();
      if (!existsSync(filePath)) return;

      const raw = readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw) as Partial<ProxiesFile>;

      if (Array.isArray(data.proxies)) {
        for (const p of data.proxies) {
          if (p && typeof p.id === "string" && typeof p.url === "string") {
            this.proxies.set(p.id, {
              id: p.id,
              name: p.name ?? "",
              url: p.url,
              status: p.status ?? "active",
              health: p.health ?? null,
              addedAt: p.addedAt ?? new Date().toISOString(),
            });
          }
        }
      }

      if (Array.isArray(data.assignments)) {
        for (const a of data.assignments) {
          if (
            a &&
            typeof a.accountId === "string" &&
            typeof a.proxyId === "string"
          ) {
            this.assignments.set(a.accountId, a.proxyId);
          }
        }
      }

      if (typeof data.healthCheckIntervalMinutes === "number") {
        this.healthIntervalMin = Math.max(1, data.healthCheckIntervalMinutes);
      }

      if (this.proxies.size > 0) {
        console.log(
          `[ProxyPool] Loaded ${this.proxies.size} proxies, ${this.assignments.size} assignments`,
        );
      }
    } catch (err) {
      console.warn(
        "[ProxyPool] Failed to load:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  destroy(): void {
    this.stopHealthCheckTimer();
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.persistNow();
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function maskProxyUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return url;
  }
}

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
