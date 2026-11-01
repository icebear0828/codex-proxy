import { describe, it, expect } from "vitest";
import { listLanIpv4Addresses, readLanRuntime } from "../../../src/utils/lan-access.js";
import type { networkInterfaces } from "node:os";

describe("LAN addresses", () => {
  it("filters loopback and IPv6, deduplicates and sorts candidates", () => {
    const interfaces = { eth: [
      { address: "192.168.1.20", family: "IPv4", internal: false },
      { address: "192.168.1.20", family: "IPv4", internal: false },
      { address: "10.0.0.2", family: "IPv4", internal: false },
      { address: "::1", family: "IPv6", internal: true },
      { address: "127.0.0.1", family: "IPv4", internal: true },
    ], empty: undefined } as ReturnType<typeof networkInterfaces>;
    expect(listLanIpv4Addresses(interfaces)).toEqual(["10.0.0.2", "192.168.1.20"]);
  });
  it("handles no interfaces", () => {
    expect(listLanIpv4Addresses({})).toEqual([]);
  });
});


import { createServer } from "node:http";
import { once } from "node:events";

it("reads ephemeral ports per server and returns null after close", async () => {
  const first = createServer();
  const second = createServer();
  expect(readLanRuntime(first)).toBeNull();
  first.listen(0, "127.0.0.1");
  second.listen(0, "127.0.0.1");
  await Promise.all([once(first, "listening"), once(second, "listening")]);
  try {
    const a = readLanRuntime(first)!;
    const b = readLanRuntime(second)!;
    expect(a.host).toBe("127.0.0.1");
    expect(a.port).toBeGreaterThan(0);
    expect(a.port).not.toBe(b.port);
    expect(a.port).toBe((first.address() as { port: number }).port);
  } finally {
    await Promise.all([new Promise<void>(resolve => first.close(() => resolve())), new Promise<void>(resolve => second.close(() => resolve()))]);
  }
  expect(readLanRuntime(first)).toBeNull();
  expect(readLanRuntime(second)).toBeNull();
});
