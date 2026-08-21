/**
 * Installation ID — stable per-installation UUID sent to upstream as both
 * `x-codex-installation-id` HTTP header and inside the request body's
 * `client_metadata` map. Real Codex CLI uses this as a routing/affinity
 * hint so the upstream LB can pin a single client to the same backend
 * instance, which keeps the prompt cache warm across turns.
 *
 * Lookup order:
 *   1. `~/.codex/installation_id` if it exists and parses as a UUID
 *      (mirrors the user's actual Codex Desktop install).
 *   2. `<dataDir>/installation_id` if previously persisted.
 *   3. Generate a new UUID, persist to `<dataDir>/installation_id`.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";
import { randomUUID, createHash } from "crypto";
import { getDataDir } from "../paths.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let _cachedGlobal: string | null = null;
const _accountCache = new Map<string, string>();

function readUuidFile(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const trimmed = readFileSync(path, "utf-8").trim();
    return UUID_RE.test(trimmed) ? trimmed : null;
  } catch {
    return null;
  }
}

function persistUuid(path: string, uuid: string): void {
  try {
    const dir = resolve(path, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, uuid, "utf-8");
  } catch (err) {
    console.warn(`[InstallationId] Failed to persist to ${path}:`, err instanceof Error ? err.message : err);
  }
}

function getGlobalInstallationId(): string {
  if (_cachedGlobal) return _cachedGlobal;

  const codexHome = resolve(homedir(), ".codex", "installation_id");
  const fromCodex = readUuidFile(codexHome);
  if (fromCodex) {
    _cachedGlobal = fromCodex;
    return fromCodex;
  }

  const ourFile = resolve(getDataDir(), "installation_id");
  const fromOurs = readUuidFile(ourFile);
  if (fromOurs) {
    _cachedGlobal = fromOurs;
    return fromOurs;
  }

  const generated = randomUUID();
  persistUuid(ourFile, generated);
  _cachedGlobal = generated;
  return generated;
}

function sanitizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function deriveAccountUuid(baseUuid: string, accountScope: string): string {
  const hash = createHash("sha256")
    .update(baseUuid)
    .update("\0")
    .update(accountScope)
    .digest("hex");
  const p1 = hash.slice(0, 8);
  const p2 = hash.slice(8, 12);
  const p3 = "4" + hash.slice(13, 16);
  const p4 = ((parseInt(hash.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0") + hash.slice(18, 20);
  const p5 = hash.slice(20, 32);
  return `${p1}-${p2}-${p3}-${p4}-${p5}`;
}

export function getInstallationId(accountScope?: string | null): string {
  if (!accountScope || !accountScope.trim()) {
    return getGlobalInstallationId();
  }

  const scope = accountScope.trim();
  const cached = _accountCache.get(scope);
  if (cached) return cached;

  const safeName = sanitizeKey(scope);
  const accountFile = resolve(getDataDir(), "installation_ids", `${safeName}.id`);
  const fromDisk = readUuidFile(accountFile);
  if (fromDisk) {
    _accountCache.set(scope, fromDisk);
    return fromDisk;
  }

  const baseUuid = getGlobalInstallationId();
  const derived = deriveAccountUuid(baseUuid, scope);
  persistUuid(accountFile, derived);
  _accountCache.set(scope, derived);
  return derived;
}

/** Test-only: clear memoized value so the next call re-resolves. */
export function _resetInstallationIdForTests(): void {
  _cachedGlobal = null;
  _accountCache.clear();
}

