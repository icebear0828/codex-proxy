import { createHash } from "crypto";
import { getConfig } from "../config.js";

const MAX_SESSIONS = 10000;

interface Session {
  taskId: string;
  turnId: string;
  messageHash: string;
  responseId: string | null;
  createdAt: number;
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private ttlMs: number;
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
    const { ttl_minutes, cleanup_interval_minutes } = getConfig().session;
    this.ttlMs = ttl_minutes * 60 * 1000;
    this.cleanupTimer = setInterval(
      () => this.cleanup(),
      cleanup_interval_minutes * 60 * 1000,
    );
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
  }

  /**
   * Hash the message history to create a session key
   */
  hashMessages(
    messages: Array<{ role: string; content: string }>,
  ): string {
    const data = JSON.stringify(messages.map((m) => [m.role, m.content]));
    return createHash("sha256").update(data).digest("hex").slice(0, 32);
  }

  /**
   * Find an existing session that matches the message history prefix
   */
  findSession(
    messages: Array<{ role: string; content: string }>,
  ): Session | null {
    // Try matching all messages except the last (the new user message)
    if (messages.length < 2) return null;
    const prefix = messages.slice(0, -1);
    const hash = this.hashMessages(prefix);

    for (const session of this.sessions.values()) {
      if (
        session.messageHash === hash &&
        Date.now() - session.createdAt < this.ttlMs
      ) {
        return session;
      }
    }
    return null;
  }

  /**
   * Store a session after task creation
   */
  storeSession(
    taskId: string,
    turnId: string,
    messages: Array<{ role: string; content: string }>,
  ): void {
    const hash = this.hashMessages(messages);
    // P2-10: O(1) LRU eviction using Map insertion order
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldestKey = this.sessions.keys().next().value;
      if (oldestKey) this.sessions.delete(oldestKey);
    }
    this.sessions.set(taskId, {
      taskId,
      turnId,
      messageHash: hash,
      responseId: null,
      createdAt: Date.now(),
    });
  }

  /**
   * Update the response ID for an existing session (for multi-turn previous_response_id)
   */
  updateResponseId(taskId: string, responseId: string): void {
    const session = this.sessions.get(taskId);
    if (session) session.responseId = responseId;
  }

  /**
   * Update turn ID for an existing session
   */
  updateTurn(taskId: string, turnId: string): void {
    const session = this.sessions.get(taskId);
    if (session) {
      session.turnId = turnId;
    }
  }

  /**
   * Get session by explicit task ID
   */
  getSession(taskId: string): Session | null {
    return this.sessions.get(taskId) ?? null;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (now - session.createdAt > this.ttlMs) {
        this.sessions.delete(key);
      }
    }
  }
}
