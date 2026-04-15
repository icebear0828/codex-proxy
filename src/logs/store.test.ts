import { describe, it, expect, beforeEach } from "vitest";
import { LogStore } from "./store.js";

describe("LogStore", () => {
  let store: LogStore;

  beforeEach(() => {
    store = new LogStore(10);
  });

  it("returns newest records first when listing", async () => {
    store.enqueue({
      id: "1",
      requestId: "r1",
      direction: "ingress",
      ts: new Date().toISOString(),
      method: "POST",
      path: "/a",
    });
    store.enqueue({
      id: "2",
      requestId: "r2",
      direction: "ingress",
      ts: new Date().toISOString(),
      method: "POST",
      path: "/b",
    });

    await Promise.resolve();
    const result = store.list({ limit: 10, offset: 0 });
    expect(result.records.map((r) => r.id)).toEqual(["2", "1"]);
  });

  it("filters by direction and search", async () => {
    store.enqueue({
      id: "1",
      requestId: "r1",
      direction: "ingress",
      ts: new Date().toISOString(),
      method: "POST",
      path: "/v1/messages",
      model: "claude",
    });
    store.enqueue({
      id: "2",
      requestId: "r2",
      direction: "egress",
      ts: new Date().toISOString(),
      method: "GET",
      path: "/health",
      provider: "codex",
    });

    await Promise.resolve();
    const filtered = store.list({ direction: "egress", search: "codex", limit: 10, offset: 0 });
    expect(filtered.total).toBe(1);
    expect(filtered.records.map((r) => r.id)).toEqual(["2"]);
  });

  it("normalizes invalid pagination values", async () => {
    store.enqueue({
      id: "1",
      requestId: "r1",
      direction: "ingress",
      ts: new Date().toISOString(),
      method: "POST",
      path: "/a",
    });

    await Promise.resolve();
    const result = store.list({ limit: Number.NaN, offset: Number.NaN });
    expect(result.limit).toBe(50);
    expect(result.offset).toBe(0);
  });

  it("redacts request payloads on flush", async () => {
    store.enqueue({
      id: "1",
      requestId: "r1",
      direction: "ingress",
      ts: new Date().toISOString(),
      method: "POST",
      path: "/a",
      request: {
        headers: { authorization: "Bearer secret" },
        nested: { token: "abc" },
      },
    });

    await Promise.resolve();
    const result = store.list({ limit: 10, offset: 0 });
    expect(result.records[0].request).toMatchObject({
      headers: { authorization: "Bea***et" },
      nested: { token: "***" },
    });
  });
});
