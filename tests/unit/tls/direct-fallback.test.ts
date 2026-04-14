import { describe, it, expect } from "vitest";
import { isProxyNetworkError, isSafeToRetryRefresh } from "@src/tls/direct-fallback.js";

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

  // reqwest / native transport patterns
  it("detects reqwest 'error sending request'", () => {
    expect(
      isProxyNetworkError(
        new Error("POST failed: error sending request for url (https://auth.openai.com/oauth/token)"),
      ),
    ).toBe(true);
  });

  it("detects DNS error from reqwest", () => {
    expect(
      isProxyNetworkError(
        new Error("POST failed: error sending request for url: dns error: failed to lookup address"),
      ),
    ).toBe(true);
  });

  it("detects hyper connection error", () => {
    expect(
      isProxyNetworkError(new Error("error trying to connect: tcp connect error")),
    ).toBe(true);
  });

  it("detects connection refused (OS-level)", () => {
    expect(
      isProxyNetworkError(new Error("connection refused")),
    ).toBe(true);
  });

  it("detects TLS handshake failure", () => {
    expect(
      isProxyNetworkError(new Error("tls handshake eof")),
    ).toBe(true);
  });

  it("detects network unreachable", () => {
    expect(
      isProxyNetworkError(new Error("network is unreachable")),
    ).toBe(true);
  });
});

describe("isSafeToRetryRefresh", () => {
  it("allows retry on DNS error", () => {
    expect(isSafeToRetryRefresh(new Error("dns error: failed to lookup"))).toBe(true);
  });

  it("allows retry on connection refused", () => {
    expect(isSafeToRetryRefresh(new Error("connection refused"))).toBe(true);
  });

  it("allows retry on TLS handshake", () => {
    expect(isSafeToRetryRefresh(new Error("tls handshake timeout"))).toBe(true);
  });

  it("allows retry on network unreachable", () => {
    expect(isSafeToRetryRefresh(new Error("network is unreachable"))).toBe(true);
  });

  it("does NOT allow retry on generic 'error sending request'", () => {
    // "error sending request" could be mid-flight — not safe for one-time RT
    expect(isSafeToRetryRefresh(new Error("error sending request for url"))).toBe(false);
  });

  it("does NOT allow retry on timeout (mid-flight)", () => {
    expect(isSafeToRetryRefresh(new Error("operation timed out"))).toBe(false);
  });
});
