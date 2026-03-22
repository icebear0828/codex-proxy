/**
 * Dashboard Session Store — in-memory session management for web dashboard login gate.
 *
 * Sessions are cookie-based and protect the dashboard when proxy_api_key is set
 * and requests come from non-localhost origins. TTL is configured via session.ttl_minutes.
 *
 * Sessions are NOT persisted — server restart requires re-login, which is acceptable.
 */

import { randomUUID } from "crypto";
import { getConfig } from "../config.js";

export interface DashboardSession {
  id: string;
  createdAt: number;
  expiresAt: number;
}

const sessions = new Map<string, DashboardSession>();
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

export function createSession(): DashboardSession {
  const config = getConfig();
  const ttlMs = config.session.ttl_minutes * 60_000;
  const now = Date.now();
  const session: DashboardSession = {
    id: randomUUID(),
    createdAt: now,
    expiresAt: now + ttlMs,
  };
  sessions.set(session.id, session);
  return session;
}

export function validateSession(id: string): boolean {
  const session = sessions.get(id);
  if (!session) return false;
  if (Date.now() > session.expiresAt) {
    sessions.delete(id);
    return false;
  }
  return true;
}

export function deleteSession(id: string): void {
  sessions.delete(id);
}

export function getSessionCount(): number {
  return sessions.size;
}

function cleanupExpired(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now > session.expiresAt) {
      sessions.delete(id);
    }
  }
}

export function startSessionCleanup(): void {
  if (cleanupTimer) return;
  const config = getConfig();
  const intervalMs = config.session.cleanup_interval_minutes * 60_000;
  cleanupTimer = setInterval(cleanupExpired, intervalMs);
  if (cleanupTimer.unref) cleanupTimer.unref();
}

export function stopSessionCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

/** Reset all sessions — for tests only. */
export function _resetForTest(): void {
  sessions.clear();
  stopSessionCleanup();
}
