import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { checkHttp2Fallback, isHttp11Fallback, resetCurlBinaryCache } from "../curl-binary.js";

describe("HTTP/2 → HTTP/1.1 auto-fallback", () => {
  beforeEach(() => {
    resetCurlBinaryCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("activates on curl exit code 16 (HTTP/2 framing error)", () => {
    expect(isHttp11Fallback()).toBe(false);
    const activated = checkHttp2Fallback("", 16);
    expect(activated).toBe(true);
    expect(isHttp11Fallback()).toBe(true);
  });

  it("activates on exit code 56 WITH H2 stderr", () => {
    const activated = checkHttp2Fallback("nghttp2 stream error", 56);
    expect(activated).toBe(true);
    expect(isHttp11Fallback()).toBe(true);
  });

  it("does NOT activate on exit code 56 WITHOUT H2 stderr", () => {
    const activated = checkHttp2Fallback("Connection reset by peer", 56);
    expect(activated).toBe(false);
    expect(isHttp11Fallback()).toBe(false);
  });

  it("activates on ALPN-related error in stderr", () => {
    const activated = checkHttp2Fallback("ALPN: server did not agree on a protocol", 35);
    expect(activated).toBe(true);
    expect(isHttp11Fallback()).toBe(true);
  });

  it("activates on GOAWAY frame error", () => {
    const activated = checkHttp2Fallback("HTTP/2 GOAWAY received", 92);
    expect(activated).toBe(true);
    expect(isHttp11Fallback()).toBe(true);
  });

  it("does NOT activate on unrelated curl errors", () => {
    const activated = checkHttp2Fallback("Connection refused", 7);
    expect(activated).toBe(false);
    expect(isHttp11Fallback()).toBe(false);
  });

  it("does NOT activate on exit code 0", () => {
    const activated = checkHttp2Fallback("some noise", 0);
    expect(activated).toBe(false);
    expect(isHttp11Fallback()).toBe(false);
  });

  it("does NOT activate twice while active (idempotent)", () => {
    checkHttp2Fallback("nghttp2 error", 56);
    expect(isHttp11Fallback()).toBe(true);
    const second = checkHttp2Fallback("nghttp2 error", 56);
    expect(second).toBe(false);
  });

  it("expires after TTL and retries H2", () => {
    checkHttp2Fallback("", 16);
    expect(isHttp11Fallback()).toBe(true);

    // Advance past 10-minute TTL
    vi.advanceTimersByTime(10 * 60 * 1000 + 1);

    // Next check should see it expired — but isHttp11Fallback reads raw state.
    // The expiry happens in getChromeTlsArgs(), so test via checkHttp2Fallback:
    // After TTL, a new H2 error can re-activate (returns true, not false)
    const reactivated = checkHttp2Fallback("", 16);
    expect(reactivated).toBe(true);
  });

  it("resets with resetCurlBinaryCache", () => {
    checkHttp2Fallback("", 16);
    expect(isHttp11Fallback()).toBe(true);
    resetCurlBinaryCache();
    expect(isHttp11Fallback()).toBe(false);
  });
});
