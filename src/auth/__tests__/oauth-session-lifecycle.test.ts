import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock dependencies before importing
vi.mock("../../config.js", () => ({
  getConfig: () => ({
    auth: {
      oauth_client_id: "test-client",
      oauth_auth_endpoint: "https://auth.example.com/authorize",
      oauth_token_endpoint: "https://auth.example.com/token",
    },
  }),
}));

vi.mock("../../tls/curl-fetch.js", () => ({
  curlFetchPost: vi.fn(),
}));

vi.mock("../../tls/direct-fallback.js", () => ({
  withDirectFallback: vi.fn((fn: (p: unknown) => Promise<unknown>) => fn(undefined)),
  isCloudflareChallengeResponse: vi.fn(() => false),
}));

describe("OAuth session lifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("peekSession returns session without removing it", async () => {
    const { createOAuthSession, peekSession } = await import("../oauth-pkce.js");
    const { state } = createOAuthSession("localhost:8080", "login");

    // First peek
    const session1 = peekSession(state);
    expect(session1).not.toBeNull();
    expect(session1!.codeVerifier).toBeTruthy();

    // Second peek — still there
    const session2 = peekSession(state);
    expect(session2).not.toBeNull();
    expect(session2!.codeVerifier).toBe(session1!.codeVerifier);
  });

  it("deleteSession removes the session", async () => {
    const { createOAuthSession, peekSession, deleteSession } = await import("../oauth-pkce.js");
    const { state } = createOAuthSession("localhost:8080", "login");

    expect(peekSession(state)).not.toBeNull();

    deleteSession(state);

    expect(peekSession(state)).toBeNull();
  });

  it("peekSession returns null for expired sessions", async () => {
    const { createOAuthSession, peekSession } = await import("../oauth-pkce.js");
    const { state } = createOAuthSession("localhost:8080", "login");

    // Fast-forward past TTL (5 minutes)
    vi.useFakeTimers();
    vi.advanceTimersByTime(6 * 60 * 1000);

    expect(peekSession(state)).toBeNull();

    vi.useRealTimers();
  });

  it("peekSession returns null for unknown state", async () => {
    const { peekSession } = await import("../oauth-pkce.js");
    expect(peekSession("nonexistent-state")).toBeNull();
  });

  it("consumeSession still works for backward compat", async () => {
    const { createOAuthSession, consumeSession, peekSession } = await import("../oauth-pkce.js");
    const { state } = createOAuthSession("localhost:8080", "login");

    const session = consumeSession(state);
    expect(session).not.toBeNull();

    // After consume, peek should return null
    expect(peekSession(state)).toBeNull();
  });

  it("session survives after peek (retry scenario)", async () => {
    const { createOAuthSession, peekSession } = await import("../oauth-pkce.js");
    const { state } = createOAuthSession("localhost:8080", "login");

    // Simulate first attempt — peek but exchange fails
    const session1 = peekSession(state);
    expect(session1).not.toBeNull();
    // (exchange would throw here, session not deleted)

    // Simulate retry — session still available
    const session2 = peekSession(state);
    expect(session2).not.toBeNull();
    expect(session2!.codeVerifier).toBe(session1!.codeVerifier);
  });

  it("markSessionCompleted + isSessionCompleted work correctly", async () => {
    const { createOAuthSession, deleteSession, markSessionCompleted, isSessionCompleted } =
      await import("../oauth-pkce.js");
    const { state } = createOAuthSession("localhost:8080", "login");

    expect(isSessionCompleted(state)).toBe(false);

    deleteSession(state);
    markSessionCompleted(state);

    expect(isSessionCompleted(state)).toBe(true);
  });

  it("tryAcquireSession prevents concurrent exchange", async () => {
    const { createOAuthSession, tryAcquireSession, peekSession } =
      await import("../oauth-pkce.js");
    const { state } = createOAuthSession("localhost:8080", "login");

    // First acquire succeeds
    const session1 = tryAcquireSession(state);
    expect(session1).not.toBeNull();
    expect(session1!.exchanging).toBe(true);

    // Second acquire returns null — session is being exchanged
    const session2 = tryAcquireSession(state);
    expect(session2).toBeNull();

    // peekSession still returns the session (with exchanging flag)
    const peeked = peekSession(state);
    expect(peeked).not.toBeNull();
    expect(peeked!.exchanging).toBe(true);
  });

  it("releaseSession allows retry after failed exchange", async () => {
    const { createOAuthSession, tryAcquireSession, releaseSession } =
      await import("../oauth-pkce.js");
    const { state } = createOAuthSession("localhost:8080", "login");

    // Acquire
    const session1 = tryAcquireSession(state);
    expect(session1).not.toBeNull();

    // Simulate exchange failure — release the lock
    releaseSession(state);

    // Retry should succeed
    const session2 = tryAcquireSession(state);
    expect(session2).not.toBeNull();
    expect(session2!.codeVerifier).toBe(session1!.codeVerifier);
  });

  it("tryAcquireSession returns null for unknown/expired state", async () => {
    const { tryAcquireSession } = await import("../oauth-pkce.js");
    expect(tryAcquireSession("nonexistent")).toBeNull();
  });
});
