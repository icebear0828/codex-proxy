/**
 * Tests for ProxyPool — per-account proxy management with health checks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => {
    throw new Error("ENOENT");
  }),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
}));

vi.mock("@src/paths.js", () => ({
  getDataDir: vi.fn(() => "/tmp/test-data"),
}));

vi.mock("@src/tls/transport.js", () => ({
  getTransport: vi.fn(() => ({
    get: vi.fn(),
  })),
}));

import { ProxyPool } from "@src/proxy/proxy-pool.js";
import { getTransport } from "@src/tls/transport.js";
import { readFileSync, writeFileSync, existsSync } from "fs";

describe("ProxyPool", () => {
  let pool: ProxyPool;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    pool = new ProxyPool();
  });

  afterEach(() => {
    pool.destroy();
    vi.useRealTimers();
  });

  // ── CRUD ──────────────────────────────────────────────────────────────

  describe("CRUD", () => {
    it("add generates hex ID and persists", () => {
      const id = pool.add("Test Proxy", "http://proxy.local:8080");
      expect(id).toMatch(/^[0-9a-f]{16}$/);
      expect(writeFileSync).toHaveBeenCalled();

      const entry = pool.getById(id);
      expect(entry).toBeDefined();
      expect(entry!.name).toBe("Test Proxy");
      expect(entry!.url).toBe("http://proxy.local:8080");
      expect(entry!.status).toBe("active");
      expect(entry!.health).toBeNull();
    });

    it("add with duplicate URL returns existing ID (no new entry)", () => {
      const id1 = pool.add("Proxy A", "http://proxy.local:8080");
      const id2 = pool.add("Proxy B", "http://proxy.local:8080");
      expect(id1).toBe(id2);
      expect(pool.getAll()).toHaveLength(1);
    });

    it("remove deletes entry and cleans up assignments pointing to it", () => {
      const id = pool.add("Proxy", "http://proxy.local:8080");
      pool.assign("acct1", id);
      expect(pool.getAssignment("acct1")).toBe(id);

      const removed = pool.remove(id);
      expect(removed).toBe(true);
      expect(pool.getById(id)).toBeUndefined();
      // Assignment cleaned up, falls back to "global"
      expect(pool.getAssignment("acct1")).toBe("global");
    });

    it("remove returns false for unknown ID", () => {
      expect(pool.remove("nonexistent")).toBe(false);
    });

    it("update changes name, trims it", () => {
      const id = pool.add("Old Name", "http://proxy.local:8080");
      const updated = pool.update(id, { name: "  New Name  " });
      expect(updated).toBe(true);
      expect(pool.getById(id)!.name).toBe("New Name");
    });

    it("update URL change resets health to null and status to active", () => {
      const id = pool.add("Proxy", "http://proxy.local:8080");
      // Manually set health and status to verify they get reset
      const entry = pool.getById(id)!;
      entry.health = {
        exitIp: "1.2.3.4",
        latencyMs: 100,
        lastChecked: new Date().toISOString(),
        error: null,
      };
      entry.status = "unreachable";

      pool.update(id, { url: "http://new-proxy.local:9090" });
      const updated = pool.getById(id)!;
      expect(updated.url).toBe("http://new-proxy.local:9090");
      expect(updated.health).toBeNull();
      expect(updated.status).toBe("active");
    });

    it("update returns false for unknown ID", () => {
      expect(pool.update("nonexistent", { name: "Test" })).toBe(false);
    });

    it("getAll returns all entries", () => {
      pool.add("A", "http://a.local:8080");
      pool.add("B", "http://b.local:8080");
      pool.add("C", "http://c.local:8080");
      expect(pool.getAll()).toHaveLength(3);
    });

    it("getById returns entry or undefined", () => {
      const id = pool.add("Test", "http://test.local:8080");
      expect(pool.getById(id)).toBeDefined();
      expect(pool.getById("nonexistent")).toBeUndefined();
    });
  });

  // ── Enable / Disable ──────────────────────────────────────────────────

  describe("enable/disable", () => {
    it("enable sets status to active", () => {
      const id = pool.add("Proxy", "http://proxy.local:8080");
      pool.getById(id)!.status = "unreachable";
      expect(pool.enable(id)).toBe(true);
      expect(pool.getById(id)!.status).toBe("active");
    });

    it("disable sets status to disabled", () => {
      const id = pool.add("Proxy", "http://proxy.local:8080");
      expect(pool.disable(id)).toBe(true);
      expect(pool.getById(id)!.status).toBe("disabled");
    });

    it("enable returns false for unknown ID", () => {
      expect(pool.enable("nonexistent")).toBe(false);
    });

    it("disable returns false for unknown ID", () => {
      expect(pool.disable("nonexistent")).toBe(false);
    });
  });

  // ── Assignment ─────────────────────────────────────────────────────────

  describe("Assignment", () => {
    it("assign sets mapping and persists", () => {
      const id = pool.add("Proxy", "http://proxy.local:8080");
      pool.assign("acct1", id);
      expect(pool.getAssignment("acct1")).toBe(id);
      // persistNow called by assign → writeFileSync called
      expect(writeFileSync).toHaveBeenCalled();
    });

    it("bulkAssign sets multiple at once", () => {
      const id1 = pool.add("A", "http://a.local:8080");
      const id2 = pool.add("B", "http://b.local:8080");
      pool.bulkAssign([
        { accountId: "acct1", proxyId: id1 },
        { accountId: "acct2", proxyId: id2 },
      ]);
      expect(pool.getAssignment("acct1")).toBe(id1);
      expect(pool.getAssignment("acct2")).toBe(id2);
    });

    it("unassign removes mapping", () => {
      const id = pool.add("Proxy", "http://proxy.local:8080");
      pool.assign("acct1", id);
      pool.unassign("acct1");
      expect(pool.getAssignment("acct1")).toBe("global");
    });

    it("getAssignment returns global for unassigned", () => {
      expect(pool.getAssignment("unknown-account")).toBe("global");
    });
  });

  // ── getAssignmentDisplayName ───────────────────────────────────────────

  describe("getAssignmentDisplayName", () => {
    it("returns Global Default for global assignment", () => {
      expect(pool.getAssignmentDisplayName("unassigned-acct")).toBe(
        "Global Default",
      );
    });

    it("returns Direct (No Proxy) for direct assignment", () => {
      pool.assign("acct1", "direct");
      expect(pool.getAssignmentDisplayName("acct1")).toBe("Direct (No Proxy)");
    });

    it("returns Auto (Round-Robin) for auto assignment", () => {
      pool.assign("acct1", "auto");
      expect(pool.getAssignmentDisplayName("acct1")).toBe("Auto (Round-Robin)");
    });

    it("returns proxy name for named proxy", () => {
      const id = pool.add("My Custom Proxy", "http://proxy.local:8080");
      pool.assign("acct1", id);
      expect(pool.getAssignmentDisplayName("acct1")).toBe("My Custom Proxy");
    });

    it("returns Unknown Proxy for deleted proxy", () => {
      pool.assign("acct1", "deleted-proxy-id");
      expect(pool.getAssignmentDisplayName("acct1")).toBe("Unknown Proxy");
    });
  });

  // ── resolveProxyUrl ────────────────────────────────────────────────────

  describe("resolveProxyUrl", () => {
    it("returns undefined for global assignment", () => {
      expect(pool.resolveProxyUrl("unassigned")).toBeUndefined();
    });

    it("returns null for direct assignment", () => {
      pool.assign("acct1", "direct");
      expect(pool.resolveProxyUrl("acct1")).toBeNull();
    });

    it("returns proxy URL for specific active proxy", () => {
      const id = pool.add("Proxy", "http://proxy.local:8080");
      pool.assign("acct1", id);
      expect(pool.resolveProxyUrl("acct1")).toBe("http://proxy.local:8080");
    });

    it("returns undefined for disabled proxy (fallback to global)", () => {
      const id = pool.add("Proxy", "http://proxy.local:8080");
      pool.disable(id);
      pool.assign("acct1", id);
      expect(pool.resolveProxyUrl("acct1")).toBeUndefined();
    });

    it("returns undefined for deleted proxy (fallback to global)", () => {
      pool.assign("acct1", "nonexistent-proxy");
      expect(pool.resolveProxyUrl("acct1")).toBeUndefined();
    });

    it("returns round-robin pick for auto assignment", () => {
      const id1 = pool.add("A", "http://a.local:8080");
      const id2 = pool.add("B", "http://b.local:8080");
      pool.assign("acct1", "auto");

      const urlA = pool.getById(id1)!.url;
      const urlB = pool.getById(id2)!.url;

      const result1 = pool.resolveProxyUrl("acct1");
      const result2 = pool.resolveProxyUrl("acct1");
      // Should cycle through both
      expect([urlA, urlB]).toContain(result1);
      expect([urlA, urlB]).toContain(result2);
      expect(result1).not.toBe(result2);
    });
  });

  // ── Round-robin ────────────────────────────────────────────────────────

  describe("Round-robin", () => {
    it("cycles through active proxies", () => {
      pool.add("A", "http://a.local:8080");
      pool.add("B", "http://b.local:8080");
      pool.add("C", "http://c.local:8080");
      pool.assign("acct1", "auto");

      const seen = new Set<string | null | undefined>();
      for (let i = 0; i < 3; i++) {
        seen.add(pool.resolveProxyUrl("acct1"));
      }
      expect(seen.size).toBe(3);
    });

    it("returns undefined when no active proxies exist", () => {
      pool.assign("acct1", "auto");
      expect(pool.resolveProxyUrl("acct1")).toBeUndefined();
    });
  });

  // ── Health Check ───────────────────────────────────────────────────────

  describe("healthCheck", () => {
    it("success: updates health info and sets status to active", async () => {
      const mockGet = vi
        .fn()
        .mockResolvedValue({ body: '{"ip":"1.2.3.4"}', headers: {} });
      vi.mocked(getTransport).mockReturnValue({
        get: mockGet,
      } as ReturnType<typeof getTransport>);

      const id = pool.add("Proxy", "http://proxy.local:8080");
      const info = await pool.healthCheck(id);

      expect(info.exitIp).toBe("1.2.3.4");
      expect(info.error).toBeNull();
      expect(info.latencyMs).toBeGreaterThanOrEqual(0);
      expect(pool.getById(id)!.status).toBe("active");
      expect(pool.getById(id)!.health).toBe(info);
    });

    it("failure: sets status to unreachable and records error", async () => {
      const mockGet = vi.fn().mockRejectedValue(new Error("Connection refused"));
      vi.mocked(getTransport).mockReturnValue({
        get: mockGet,
      } as ReturnType<typeof getTransport>);

      const id = pool.add("Proxy", "http://proxy.local:8080");
      const info = await pool.healthCheck(id);

      expect(info.exitIp).toBeNull();
      expect(info.error).toBe("Connection refused");
      expect(pool.getById(id)!.status).toBe("unreachable");
    });

    it("disabled proxy stays disabled on success", async () => {
      const mockGet = vi
        .fn()
        .mockResolvedValue({ body: '{"ip":"1.2.3.4"}', headers: {} });
      vi.mocked(getTransport).mockReturnValue({
        get: mockGet,
      } as ReturnType<typeof getTransport>);

      const id = pool.add("Proxy", "http://proxy.local:8080");
      pool.disable(id);

      await pool.healthCheck(id);
      expect(pool.getById(id)!.status).toBe("disabled");
    });

    it("disabled proxy stays disabled on failure", async () => {
      const mockGet = vi.fn().mockRejectedValue(new Error("timeout"));
      vi.mocked(getTransport).mockReturnValue({
        get: mockGet,
      } as ReturnType<typeof getTransport>);

      const id = pool.add("Proxy", "http://proxy.local:8080");
      pool.disable(id);

      await pool.healthCheck(id);
      expect(pool.getById(id)!.status).toBe("disabled");
    });

    it("throws Error for unknown ID", async () => {
      await expect(pool.healthCheck("nonexistent")).rejects.toThrow(
        "Proxy nonexistent not found",
      );
    });
  });

  // ── healthCheckAll ─────────────────────────────────────────────────────

  describe("healthCheckAll", () => {
    it("skips disabled proxies", async () => {
      const mockGet = vi
        .fn()
        .mockResolvedValue({ body: '{"ip":"1.2.3.4"}', headers: {} });
      vi.mocked(getTransport).mockReturnValue({
        get: mockGet,
      } as ReturnType<typeof getTransport>);

      const id1 = pool.add("Active", "http://active.local:8080");
      const id2 = pool.add("Disabled", "http://disabled.local:8080");
      pool.disable(id2);

      await pool.healthCheckAll();

      // Only the active proxy should have been checked
      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(pool.getById(id1)!.health).not.toBeNull();
      // Disabled proxy not checked (health stays null)
      expect(pool.getById(id2)!.health).toBeNull();
    });

    it("empty list does nothing", async () => {
      const mockGet = vi.fn();
      vi.mocked(getTransport).mockReturnValue({
        get: mockGet,
      } as ReturnType<typeof getTransport>);

      await pool.healthCheckAll();
      expect(mockGet).not.toHaveBeenCalled();
    });
  });

  // ── Persistence ────────────────────────────────────────────────────────

  describe("Persistence", () => {
    it("persistNow writes JSON via tmp+rename", () => {
      pool.add("Proxy", "http://proxy.local:8080");
      // add calls persistNow internally
      const calls = vi.mocked(writeFileSync).mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall[0]).toMatch(/proxies\.json\.tmp$/);
      const written = JSON.parse(lastCall[1] as string);
      expect(written.proxies).toHaveLength(1);
      expect(written.proxies[0].url).toBe("http://proxy.local:8080");
      expect(written.assignments).toEqual([]);
    });

    it("load restores proxies and assignments from file", () => {
      const savedData = {
        proxies: [
          {
            id: "abc123",
            name: "Saved Proxy",
            url: "http://saved.local:8080",
            status: "active",
            health: null,
            addedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        assignments: [{ accountId: "acct1", proxyId: "abc123" }],
        healthCheckIntervalMinutes: 10,
      };

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(savedData));

      // Create a fresh pool that will load from file
      const newPool = new ProxyPool();
      expect(newPool.getAll()).toHaveLength(1);
      expect(newPool.getById("abc123")!.name).toBe("Saved Proxy");
      expect(newPool.getAssignment("acct1")).toBe("abc123");
      expect(newPool.getHealthIntervalMinutes()).toBe(10);
      newPool.destroy();
    });

    it("missing file results in empty state (no error)", () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const newPool = new ProxyPool();
      expect(newPool.getAll()).toHaveLength(0);
      newPool.destroy();
    });

    it("corrupted JSON warns but does not crash", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue("not valid json {{{");
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const newPool = new ProxyPool();
      expect(newPool.getAll()).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalled();
      newPool.destroy();
      warnSpy.mockRestore();
    });
  });

  // ── schedulePersist debounce ───────────────────────────────────────────

  describe("schedulePersist debounce", () => {
    it("update triggers debounced persist after 1000ms", () => {
      const id = pool.add("Proxy", "http://proxy.local:8080");
      vi.mocked(writeFileSync).mockClear();

      pool.update(id, { name: "Updated" });
      // Not yet persisted (debounced)
      expect(writeFileSync).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1100);
      expect(writeFileSync).toHaveBeenCalled();
    });
  });

  // ── destroy ────────────────────────────────────────────────────────────

  describe("destroy", () => {
    it("stops health timer and calls persistNow", () => {
      pool.add("Proxy", "http://proxy.local:8080");
      pool.startHealthCheckTimer();
      vi.mocked(writeFileSync).mockClear();

      pool.destroy();

      // persistNow called during destroy
      expect(writeFileSync).toHaveBeenCalled();
    });
  });
});
