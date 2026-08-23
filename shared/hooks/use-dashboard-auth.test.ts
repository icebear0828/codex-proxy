import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isDashboardAuthExpiredResponse } from "./use-dashboard-auth.js";

describe("isDashboardAuthExpiredResponse", () => {
  it("identifies 401 with x-dashboard-auth: required as expired", () => {
    const expiredResp = new Response(JSON.stringify({ error: "Dashboard login required" }), {
      status: 401,
      headers: { "x-dashboard-auth": "required" },
    });
    expect(isDashboardAuthExpiredResponse(expiredResp)).toBe(true);
  });

  it("does not classify 401 without x-dashboard-auth header as expired", () => {
    const provider401 = new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
    });
    expect(isDashboardAuthExpiredResponse(provider401)).toBe(false);
  });

  it("does not classify non-401 responses as expired", () => {
    const okResp = new Response("{}", {
      status: 200,
      headers: { "x-dashboard-auth": "required" },
    });
    expect(isDashboardAuthExpiredResponse(okResp)).toBe(false);

    const forbiddenResp = new Response("{}", {
      status: 403,
    });
    expect(isDashboardAuthExpiredResponse(forbiddenResp)).toBe(false);
  });
});

describe("installFetchInterceptor", () => {
  it("dispatches auth-expired when x-dashboard-auth: required is present on 401", async () => {
    const { installFetchInterceptor, AUTH_EXPIRED_EVENT } = await import("./use-dashboard-auth.js");
    const eventHandler = vi.fn();
    const mockOriginalFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "x-dashboard-auth": "required" },
    }));

    Object.defineProperty(globalThis, "window", {
      value: {
        fetch: mockOriginalFetch,
        dispatchEvent: eventHandler,
      },
      configurable: true,
      writable: true,
    });

    installFetchInterceptor();
    await window.fetch("/auth/accounts");

    expect(eventHandler).toHaveBeenCalled();
    const event = eventHandler.mock.calls[0][0] as Event;
    expect(event.type).toBe(AUTH_EXPIRED_EVENT);
  });

  it("does not dispatch auth-expired when /auth/api-keys/models returns 401 without dashboard-auth header", async () => {
    const { installFetchInterceptor } = await import("./use-dashboard-auth.js");
    const eventHandler = vi.fn();
    const mockOriginalFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Failed to fetch models: unauthorized" }), {
      status: 401,
    }));

    Object.defineProperty(globalThis, "window", {
      value: {
        fetch: mockOriginalFetch,
        dispatchEvent: eventHandler,
      },
      configurable: true,
      writable: true,
    });

    installFetchInterceptor();
    await window.fetch("/auth/api-keys/models");

    expect(eventHandler).not.toHaveBeenCalled();
  });
});
