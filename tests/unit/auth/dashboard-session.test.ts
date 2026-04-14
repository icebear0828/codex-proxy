import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockConfig } from "@helpers/config.js";
import { setConfigForTesting, resetConfigForTesting } from "@src/config.js";
import {
  createSession,
  validateSession,
  deleteSession,
  getSessionCount,
  startSessionCleanup,
  stopSessionCleanup,
  _resetForTest,
} from "@src/auth/dashboard-session.js";

beforeEach(() => {
  setConfigForTesting(createMockConfig({
    session: { ttl_minutes: 1, cleanup_interval_minutes: 1 },
  }));
  _resetForTest();
  vi.restoreAllMocks();
});

afterEach(() => {
  stopSessionCleanup();
  _resetForTest();
  resetConfigForTesting();
});

describe("dashboard-session", () => {
  it("createSession returns a session with id", () => {
    const session = createSession();
    expect(session.id).toBeTruthy();
    expect(typeof session.id).toBe("string");
    expect(session.expiresAt).toBeGreaterThan(Date.now());
  });

  it("validateSession returns true for valid session", () => {
    const session = createSession();
    expect(validateSession(session.id)).toBe(true);
  });

  it("validateSession returns false for nonexistent session", () => {
    expect(validateSession("nonexistent")).toBe(false);
  });

  it("validateSession returns false for expired session", () => {
    const session = createSession();
    // Manually expire it
    vi.spyOn(Date, "now").mockReturnValue(session.expiresAt + 1);
    expect(validateSession(session.id)).toBe(false);
    vi.restoreAllMocks();
  });

  it("deleteSession invalidates the session", () => {
    const session = createSession();
    expect(validateSession(session.id)).toBe(true);
    deleteSession(session.id);
    expect(validateSession(session.id)).toBe(false);
  });

  it("getSessionCount tracks correctly", () => {
    expect(getSessionCount()).toBe(0);
    createSession();
    createSession();
    expect(getSessionCount()).toBe(2);
  });

  it("validateSession extends expiresAt on access (sliding window)", () => {
    const session = createSession();
    const originalExpiry = session.expiresAt;

    // Advance time by 30 seconds — still valid, should renew
    const laterTime = session.createdAt + 30_000;
    vi.spyOn(Date, "now").mockReturnValue(laterTime);

    expect(validateSession(session.id)).toBe(true);

    // expiresAt should have been extended from laterTime
    // TTL is 1 minute in test config → new expiry = laterTime + 60_000
    vi.restoreAllMocks();

    // Advance to just after original expiry but before new expiry
    vi.spyOn(Date, "now").mockReturnValue(originalExpiry + 1);
    expect(validateSession(session.id)).toBe(true); // still valid due to renewal
    vi.restoreAllMocks();
  });

  it("cleanup removes expired sessions", () => {
    vi.useFakeTimers();
    const baseTime = Date.now();

    const s1 = createSession();
    const s2 = createSession();
    expect(getSessionCount()).toBe(2);

    // Expire both sessions (ttl_minutes=1 → 60_000ms)
    vi.setSystemTime(baseTime + 60_001);

    // Start cleanup and advance to trigger interval (cleanup_interval_minutes=1 → 60_000ms)
    startSessionCleanup();
    vi.advanceTimersByTime(60_001);

    expect(validateSession(s1.id)).toBe(false);
    expect(validateSession(s2.id)).toBe(false);

    vi.useRealTimers();
  });
});
