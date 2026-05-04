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
import { randomUUID } from "crypto";
import { getDataDir } from "../paths.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let _cached: string | null = null;

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

export function getInstallationId(): string {
  if (_cached) return _cached;

  const codexHome = resolve(homedir(), ".codex", "installation_id");
  const fromCodex = readUuidFile(codexHome);
  if (fromCodex) {
    _cached = fromCodex;
    return fromCodex;
  }

  const ourFile = resolve(getDataDir(), "installation_id");
  const fromOurs = readUuidFile(ourFile);
  if (fromOurs) {
    _cached = fromOurs;
    return fromOurs;
  }

  const generated = randomUUID();
  persistUuid(ourFile, generated);
  _cached = generated;
  return generated;
}

/** Test-only: clear memoized value so the next call re-resolves. */
export function _resetInstallationIdForTests(): void {
  _cached = null;
}
