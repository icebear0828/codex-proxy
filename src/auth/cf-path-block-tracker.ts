/**
 * Tracks consecutive Cloudflare path-block 404s per account entry.
 *
 * Background: Cloudflare's Bot Management can answer a "trust this client"
 * mismatch with an empty-body 404 on the guarded path (e.g.
 * /codex/responses) while leaving lighter paths (e.g. /codex/usage)
 * reachable. The proxy reacts by clearing the account's cookie jar and
 * retrying on a different account; this tracker watches for the
 * pathological case where cookie clearing doesn't help (repeated CF
 * blocks even with empty jar). When a configurable threshold is hit
 * inside a sliding window, the account is disabled so it stops poisoning
 * affinity routing for the same conversation.
 *
 * Stale entries (no increment within the window) auto-reset on the next
 * increment, so an isolated CF blip never adds up over days into a
 * spurious disable.
 */

const STALE_MS = 60 * 60 * 1000; // 1h sliding window

interface BlockState {
  count: number;
  lastAt: number;
}

const counts = new Map<string, BlockState>();

/**
 * Record one CF path-block 404 for the given entryId and return the
 * resulting consecutive-block count (within the sliding window).
 */
export function recordCfPathBlock(entryId: string, now: number = Date.now()): number {
  const prev = counts.get(entryId);
  const count = !prev || now - prev.lastAt > STALE_MS ? 1 : prev.count + 1;
  counts.set(entryId, { count, lastAt: now });
  return count;
}

/** Reset the counter for an entry (e.g. on manual re-activation). */
export function resetCfPathBlock(entryId: string): void {
  counts.delete(entryId);
}

/** Current count for an entry, without mutating. Returns 0 if absent or stale. */
export function peekCfPathBlock(entryId: string, now: number = Date.now()): number {
  const prev = counts.get(entryId);
  if (!prev) return 0;
  if (now - prev.lastAt > STALE_MS) return 0;
  return prev.count;
}

/** Visible for tests. */
export function _resetAllCfPathBlocks(): void {
  counts.clear();
}
