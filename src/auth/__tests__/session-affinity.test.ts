import { describe, it, expect, afterEach } from "vitest";
import { SessionAffinityMap } from "../session-affinity.js";

describe("SessionAffinityMap", () => {
  let map: SessionAffinityMap;

  afterEach(() => {
    map?.dispose();
  });

  it("records and looks up a mapping", () => {
    map = new SessionAffinityMap();
    map.record("resp_abc", "entry_123");
    expect(map.lookup("resp_abc")).toBe("entry_123");
  });

  it("returns null for unknown response IDs", () => {
    map = new SessionAffinityMap();
    expect(map.lookup("resp_unknown")).toBeNull();
  });

  it("overwrites previous mapping for same response ID", () => {
    map = new SessionAffinityMap();
    map.record("resp_abc", "entry_1");
    map.record("resp_abc", "entry_2");
    expect(map.lookup("resp_abc")).toBe("entry_2");
  });

  it("expires entries after TTL", () => {
    map = new SessionAffinityMap(50); // 50ms TTL
    map.record("resp_abc", "entry_123");
    expect(map.lookup("resp_abc")).toBe("entry_123");

    // Manually advance time by mutating the entry
    // Use a synchronous wait approach
    const start = Date.now();
    while (Date.now() - start < 60) {
      // busy wait
    }
    expect(map.lookup("resp_abc")).toBeNull();
  });

  it("tracks size correctly", () => {
    map = new SessionAffinityMap();
    expect(map.size).toBe(0);
    map.record("resp_1", "entry_1");
    map.record("resp_2", "entry_2");
    expect(map.size).toBe(2);
  });

  it("cleans up on dispose", () => {
    map = new SessionAffinityMap();
    map.record("resp_1", "entry_1");
    map.dispose();
    expect(map.size).toBe(0);
  });
});
