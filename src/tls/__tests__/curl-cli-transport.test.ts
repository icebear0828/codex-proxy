import { describe, it, expect, vi } from "vitest";

vi.mock("../curl-binary.js", () => ({
  resolveCurlBinary: () => "/mock/bin/curl-impersonate",
  getChromeTlsArgs: () => [],
  getProxyArgs: () => [],
  isImpersonate: () => true,
}));

import { formatSpawnError } from "../curl-cli-transport.js";

describe("formatSpawnError", () => {
  it("returns architecture mismatch hint for errno -86 (EBADARCH)", () => {
    const err = Object.assign(new Error("spawn Unknown system error -86"), { errno: -86 });
    const msg = formatSpawnError(err);
    expect(msg).toContain("wrong CPU architecture");
    expect(msg).toContain(process.arch);
    expect(msg).toContain("npm run setup");
    expect(msg).toContain("/mock/bin/curl-impersonate");
  });

  it("detects -86 from error message when errno is not set", () => {
    const err = new Error("spawn Unknown system error -86");
    const msg = formatSpawnError(err);
    expect(msg).toContain("wrong CPU architecture");
  });

  it("returns generic message for other spawn errors", () => {
    const err = new Error("spawn ENOENT");
    const msg = formatSpawnError(err);
    expect(msg).toBe("curl spawn error: spawn ENOENT");
    expect(msg).not.toContain("architecture");
  });
});
