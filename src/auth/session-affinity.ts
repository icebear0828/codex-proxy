/**
 * Session affinity — maps Codex response IDs to account entry IDs.
 *
 * When a request includes `previous_response_id`, the proxy looks up which
 * account created that response and routes to the same account. This enables:
 *   - Server-side conversation history reuse (previous_response_id chain)
 *   - Prompt cache hits (cache is per-account on the backend)
 */

interface AffinityEntry {
  entryId: string;
  conversationId: string;
  turnState?: string;
  instructions?: string;
  inputTokens?: number;
  functionCallIds?: string[];
  createdAt: number;
}

const DEFAULT_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

export class SessionAffinityMap {
  private map = new Map<string, AffinityEntry>();
  private ttlMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  /** Record that a response was created by a specific account in a conversation. */
  record(
    responseId: string,
    entryId: string,
    conversationId: string,
    turnState?: string,
    instructions?: string,
    inputTokens?: number,
    functionCallIds?: string[],
  ): void {
    this.map.set(responseId, {
      entryId,
      conversationId,
      turnState,
      instructions,
      inputTokens,
      functionCallIds: functionCallIds ? [...functionCallIds] : undefined,
      createdAt: Date.now(),
    });
  }

  /** Look up which account created a given response. */
  lookup(responseId: string): string | null {
    const entry = this.getEntry(responseId);
    return entry?.entryId ?? null;
  }

  /** Look up the conversation ID for a given response. */
  lookupConversationId(responseId: string): string | null {
    const entry = this.getEntry(responseId);
    return entry?.conversationId ?? null;
  }

  /** Look up the latest response ID recorded for a conversation. */
  lookupLatestResponseIdByConversationId(conversationId: string): string | null {
    let latestResponseId: string | null = null;
    let latestCreatedAt = -1;
    for (const [responseId, entry] of this.map) {
      if (entry.conversationId !== conversationId) continue;
      const liveEntry = this.getEntry(responseId);
      if (!liveEntry) continue;
      if (liveEntry.createdAt >= latestCreatedAt) {
        latestCreatedAt = liveEntry.createdAt;
        latestResponseId = responseId;
      }
    }
    return latestResponseId;
  }

  /** Look up the upstream turn-state token for a given response. */
  lookupTurnState(responseId: string): string | null {
    const entry = this.getEntry(responseId);
    return entry?.turnState ?? null;
  }

  lookupInstructions(responseId: string): string | null {
    const entry = this.getEntry(responseId);
    return entry?.instructions ?? null;
  }

  lookupLatestInstructionsByConversationId(conversationId: string): string | null {
    const responseId = this.lookupLatestResponseIdByConversationId(conversationId);
    if (!responseId) return null;
    return this.lookupInstructions(responseId);
  }

  lookupInputTokens(responseId: string): number | null {
    const entry = this.getEntry(responseId);
    return entry?.inputTokens ?? null;
  }

  lookupFunctionCallIds(responseId: string): string[] {
    const entry = this.getEntry(responseId);
    return entry?.functionCallIds ? [...entry.functionCallIds] : [];
  }

  private getEntry(responseId: string): AffinityEntry | null {
    const entry = this.map.get(responseId);
    if (!entry) return null;
    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.map.delete(responseId);
      return null;
    }
    return entry;
  }

  /** Remove expired entries. */
  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.map) {
      if (now - entry.createdAt > this.ttlMs) {
        this.map.delete(key);
      }
    }
  }

  get size(): number {
    return this.map.size;
  }

  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.map.clear();
  }
}

/** Singleton instance. */
let instance: SessionAffinityMap | null = null;

export function getSessionAffinityMap(): SessionAffinityMap {
  if (!instance) {
    instance = new SessionAffinityMap();
  }
  return instance;
}
