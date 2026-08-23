import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isNonDashboardSessionEndpoint } from "./use-dashboard-auth.js";

describe("isNonDashboardSessionEndpoint", () => {
  it("recognizes proxy routes and third-party validation routes as non-dashboard session endpoints", () => {
    expect(isNonDashboardSessionEndpoint("/auth/api-keys/models")).toBe(true);
    expect(isNonDashboardSessionEndpoint("http://localhost:8080/auth/api-keys/models")).toBe(true);
    expect(isNonDashboardSessionEndpoint("/auth/dashboard-login")).toBe(true);
    expect(isNonDashboardSessionEndpoint("/auth/dashboard-status")).toBe(true);
    expect(isNonDashboardSessionEndpoint("/v1/chat/completions")).toBe(true);
    expect(isNonDashboardSessionEndpoint("/v1beta/models")).toBe(true);
    expect(isNonDashboardSessionEndpoint("/responses")).toBe(true);
  });

  it("does not classify dashboard protected endpoints as non-dashboard session endpoints", () => {
    expect(isNonDashboardSessionEndpoint("/auth/accounts")).toBe(false);
    expect(isNonDashboardSessionEndpoint("/auth/status")).toBe(false);
    expect(isNonDashboardSessionEndpoint("/admin/rotation-settings")).toBe(false);
    expect(isNonDashboardSessionEndpoint("/admin/client-keys")).toBe(false);
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
