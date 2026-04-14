import { describe, it, expect } from "vitest";
import { isLocalhostRequest } from "@src/utils/is-localhost.js";

describe("isLocalhostRequest", () => {
  it.each([
    ["", true],
    ["127.0.0.1", true],
    ["::1", true],
    ["::ffff:127.0.0.1", true],
  ])("returns true for %s", (addr, expected) => {
    expect(isLocalhostRequest(addr)).toBe(expected);
  });

  it.each([
    ["192.168.1.1", false],
    ["10.0.0.5", false],
    ["172.16.0.1", false],
    ["8.8.8.8", false],
    ["::ffff:192.168.1.1", false],
    ["2001:db8::1", false],
  ])("returns false for %s", (addr, expected) => {
    expect(isLocalhostRequest(addr)).toBe(expected);
  });
});
