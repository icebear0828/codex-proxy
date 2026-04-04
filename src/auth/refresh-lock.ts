/**
 * Per-account file lock for RT refresh operations.
 *
 * Prevents concurrent RT consumption across:
 * - RefreshScheduler recovery + probeAccount (same process)
 * - Overlapping processes during pm2 restart (cross-process)
 *
 * Uses O_CREAT | O_EXCL (atomic exclusive create) for cross-process safety.
 * Stale locks (> 5 min) are automatically broken.
 */

import { writeFileSync, unlinkSync, readFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { resolve } from "path";
import { getDataDir } from "../paths.js";

const STALE_MS = 5 * 60 * 1000; // 5 minutes

function lockDir(): string {
  const dir = resolve(getDataDir(), ".locks");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function lockPath(entryId: string): string {
  return resolve(lockDir(), `refresh-${entryId}.lock`);
}

/**
 * Try to acquire an exclusive refresh lock for an account.
 * Returns true if the lock was acquired, false if another caller holds it.
 */
export function tryAcquireRefreshLock(entryId: string): boolean {
  const path = lockPath(entryId);
  try {
    writeFileSync(path, `${process.pid}\n${Date.now()}`, { flag: "wx" });
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") return false;
    // Lock file exists — check if stale
    try {
      const content = readFileSync(path, "utf-8");
      const ts = parseInt(content.split("\n")[1], 10);
      if (!isNaN(ts) && Date.now() - ts > STALE_MS) {
        // Stale lock — break and re-acquire
        unlinkSync(path);
        return tryAcquireRefreshLock(entryId);
      }
    } catch {
      // Can't read lock — another process may have just deleted it, retry once
      try {
        writeFileSync(path, `${process.pid}\n${Date.now()}`, { flag: "wx" });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

/**
 * Release the refresh lock for an account.
 */
export function releaseRefreshLock(entryId: string): void {
  try {
    unlinkSync(lockPath(entryId));
  } catch {
    // Already deleted or never existed — fine
  }
}

/**
 * Clean up all stale lock files (call on startup).
 */
export function cleanupStaleLocks(): void {
  try {
    const dir = resolve(getDataDir(), ".locks");
    if (!existsSync(dir)) return;
    const now = Date.now();
    for (const file of readdirSync(dir)) {
      if (!file.startsWith("refresh-") || !file.endsWith(".lock")) continue;
      try {
        const content = readFileSync(resolve(dir, file), "utf-8");
        const ts = parseInt(content.split("\n")[1], 10);
        if (!isNaN(ts) && now - ts > STALE_MS) {
          unlinkSync(resolve(dir, file));
        }
      } catch {
        // Best-effort cleanup
      }
    }
  } catch {
    // Lock dir doesn't exist yet — nothing to clean
  }
}
