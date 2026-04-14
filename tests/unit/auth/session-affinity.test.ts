import { describe, it, expect, afterEach } from "vitest";
import { SessionAffinityMap } from "@src/auth/session-affinity.js";

describe("SessionAffinityMap", () => {
  let map: SessionAffinityMap;

  afterEach(() => {
    map?.dispose();
  });

  it("records and looks up a mapping", () => {
    map = new SessionAffinityMap();
    map.record("resp_abc", "entry_123", "conv_1");
    expect(map.lookup("resp_abc")).toBe("entry_123");
  });

  it("returns null for unknown response IDs", () => {
    map = new SessionAffinityMap();
    expect(map.lookup("resp_unknown")).toBeNull();
  });

  it("overwrites previous mapping for same response ID", () => {
    map = new SessionAffinityMap();
    map.record("resp_abc", "entry_1", "conv_1");
    map.record("resp_abc", "entry_2", "conv_2");
    expect(map.lookup("resp_abc")).toBe("entry_2");
  });

  it("expires entries after TTL", () => {
    map = new SessionAffinityMap(50); // 50ms TTL
    map.record("resp_abc", "entry_123", "conv_1");
    expect(map.lookup("resp_abc")).toBe("entry_123");

    const start = Date.now();
    while (Date.now() - start < 60) {
      // busy wait
    }
    expect(map.lookup("resp_abc")).toBeNull();
  });

  it("tracks size correctly", () => {
    map = new SessionAffinityMap();
    expect(map.size).toBe(0);
    map.record("resp_1", "entry_1", "conv_1");
    map.record("resp_2", "entry_2", "conv_2");
    expect(map.size).toBe(2);
  });

  it("cleans up on dispose", () => {
    map = new SessionAffinityMap();
    map.record("resp_1", "entry_1", "conv_1");
    map.dispose();
    expect(map.size).toBe(0);
  });

  // Conversation ID tracking
  it("looks up conversation ID for a response", () => {
    map = new SessionAffinityMap();
    map.record("resp_abc", "entry_1", "conv_xyz");
    expect(map.lookupConversationId("resp_abc")).toBe("conv_xyz");
  });

  it("returns null conversation ID for unknown response", () => {
    map = new SessionAffinityMap();
    expect(map.lookupConversationId("resp_unknown")).toBeNull();
  });

  it("conversation ID is inherited across response chain", () => {
    map = new SessionAffinityMap();
    // Turn 1: new conversation
    map.record("resp_1", "entry_1", "conv_abc");
    // Turn 2: inherit conv ID from turn 1
    const convId = map.lookupConversationId("resp_1");
    expect(convId).toBe("conv_abc");
    map.record("resp_2", "entry_1", convId!);
    // Turn 3: inherit from turn 2
    expect(map.lookupConversationId("resp_2")).toBe("conv_abc");
  });

  it("expires conversation ID along with entry", () => {
    map = new SessionAffinityMap(50);
    map.record("resp_abc", "entry_1", "conv_1");

    const start = Date.now();
    while (Date.now() - start < 60) {
      // busy wait
    }
    expect(map.lookupConversationId("resp_abc")).toBeNull();
  });

  // turnState tracking
  describe("turnState tracking", () => {
    it("lookupTurnState returns recorded turnState", () => {
      map = new SessionAffinityMap();
      map.record("resp_1", "entry_1", "conv_1", "ts_abc");
      expect(map.lookupTurnState("resp_1")).toBe("ts_abc");
    });

    it("lookupTurnState returns null when no turnState was recorded", () => {
      map = new SessionAffinityMap();
      map.record("resp_1", "entry_1", "conv_1");
      expect(map.lookupTurnState("resp_1")).toBeNull();
    });

    it("turnState expires along with entry", () => {
      map = new SessionAffinityMap(50);
      map.record("resp_1", "entry_1", "conv_1", "ts_abc");
      expect(map.lookupTurnState("resp_1")).toBe("ts_abc");

      const start = Date.now();
      while (Date.now() - start < 60) {
        // busy wait
      }
      expect(map.lookupTurnState("resp_1")).toBeNull();
    });

    it("turnState is updated on re-record", () => {
      map = new SessionAffinityMap();
      map.record("resp_1", "entry_1", "conv_1", "ts_old");
      map.record("resp_1", "entry_1", "conv_1", "ts_new");
      expect(map.lookupTurnState("resp_1")).toBe("ts_new");
    });
  });
});
