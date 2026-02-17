import { createHash } from "crypto";

interface Session {
  taskId: string;
  turnId: string;
  messageHash: string;
  createdAt: number;
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private ttlMs: number;

  constructor(ttlMinutes: number = 60) {
    this.ttlMs = ttlMinutes * 60 * 1000;
    // Periodically clean expired sessions
    setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  /**
   * Hash the message history to create a session key
   */
  hashMessages(
    messages: Array<{ role: string; content: string }>,
  ): string {
    const data = messages.map((m) => `${m.role}:${m.content}`).join("|");
    return createHash("sha256").update(data).digest("hex").slice(0, 16);
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
    this.sessions.set(taskId, {
      taskId,
      turnId,
      messageHash: hash,
      createdAt: Date.now(),
    });
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
