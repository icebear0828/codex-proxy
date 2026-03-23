import { describe, it, expect } from "vitest";
import { isProxyNetworkError } from "../direct-fallback.js";

describe("isProxyNetworkError", () => {
  it("detects curl exit code 5 (proxy resolution failure)", () => {
    expect(isProxyNetworkError(new Error("curl exited with code 5"))).toBe(true);
  });

  it("detects 'Could not resolve proxy' message", () => {
    expect(
      isProxyNetworkError(
        new Error("curl: (5) Could not resolve proxy: host.docker.internal"),
      ),
    ).toBe(true);
  });

  it("detects ECONNRESET", () => {
    expect(isProxyNetworkError(new Error("ECONNRESET"))).toBe(true);
  });

  it("detects ECONNREFUSED", () => {
    expect(isProxyNetworkError(new Error("ECONNREFUSED"))).toBe(true);
  });

  it("detects curl exit code 35 (TLS handshake)", () => {
    expect(isProxyNetworkError(new Error("curl exited with code 35"))).toBe(true);
  });

  it("detects curl exit code 56 (network receive)", () => {
    expect(isProxyNetworkError(new Error("curl exited with code 56"))).toBe(true);
  });

  it("detects socket hang up", () => {
    expect(isProxyNetworkError(new Error("socket hang up"))).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isProxyNetworkError(new Error("404 Not Found"))).toBe(false);
    expect(isProxyNetworkError(new Error("invalid JSON"))).toBe(false);
    expect(isProxyNetworkError(new Error("curl exited with code 22"))).toBe(false);
  });

  it("handles string errors", () => {
    expect(isProxyNetworkError("Could not resolve proxy: foo")).toBe(true);
    expect(isProxyNetworkError("some random error")).toBe(false);
  });
});
