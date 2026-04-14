/**
 * Unit tests for codex-models.ts — fetchModels and probeEndpoint.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TlsTransport } from "@src/tls/transport.js";
import { fetchModels, probeEndpoint } from "@src/proxy/codex-models.js";

// ── Mock Transport ───────────────────────────────────────────────

function createMockTransport(getImpl?: TlsTransport["get"]): TlsTransport {
  return {
    get: getImpl ?? vi.fn(async () => ({ status: 200, body: "{}" })),
    post: vi.fn(),
    simplePost: vi.fn(),
    isImpersonate: () => false,
  } as unknown as TlsTransport;
}

const apiConfig = { base_url: "https://api.example.com", app_version: "1.0.0" };
const headers = { Authorization: "Bearer test", "ChatGPT-Account-Id": "acct-1" };

beforeEach(() => {
  vi.clearAllMocks();
});

// ── fetchModels ──────────────────────────────────────────────────

describe("fetchModels", () => {
  it("returns models from first successful endpoint", async () => {
    const transport = createMockTransport(vi.fn(async () => ({
      status: 200,
      body: JSON.stringify({ models: [{ slug: "gpt-5.4" }, { slug: "gpt-5.2-codex" }] }),
    })));

    const result = await fetchModels({ ...headers }, null, apiConfig, transport);
    expect(result).toHaveLength(2);
    expect(result![0].slug).toBe("gpt-5.4");
  });

  it("tries next endpoint when first fails", async () => {
    let callCount = 0;
    const transport = createMockTransport(vi.fn(async () => {
      callCount++;
      if (callCount === 1) throw new Error("timeout");
      return { status: 200, body: JSON.stringify({ models: [{ slug: "fallback" }] }) };
    }));

    const result = await fetchModels({ ...headers }, null, apiConfig, transport);
    expect(result).toHaveLength(1);
    expect(result![0].slug).toBe("fallback");
    expect(callCount).toBe(2);
  });

  it("returns null when all endpoints fail", async () => {
    const transport = createMockTransport(vi.fn(async () => {
      throw new Error("network error");
    }));

    const result = await fetchModels({ ...headers }, null, apiConfig, transport);
    expect(result).toBeNull();
  });

  it("flattens nested categories into a single list", async () => {
    const transport = createMockTransport(vi.fn(async () => ({
      status: 200,
      body: JSON.stringify({
        categories: [
          {
            category: "chat",
            models: [{ slug: "gpt-5.4" }, { slug: "gpt-5.2" }],
          },
          {
            category: "code",
            models: [{ slug: "gpt-5.2-codex" }],
          },
        ],
      }),
    })));

    const result = await fetchModels({ ...headers }, null, apiConfig, transport);
    expect(result).toHaveLength(3);
    expect(result!.map((m) => m.slug)).toEqual(["gpt-5.4", "gpt-5.2", "gpt-5.2-codex"]);
  });

  it("handles sentinel/chat-requirements format", async () => {
    let callCount = 0;
    const transport = createMockTransport(vi.fn(async () => {
      callCount++;
      if (callCount < 3) throw new Error("not found");
      return {
        status: 200,
        body: JSON.stringify({
          chat_models: {
            models: [{ slug: "sentinel-model" }],
          },
        }),
      };
    }));

    const result = await fetchModels({ ...headers }, null, apiConfig, transport);
    expect(result).toHaveLength(1);
    expect(result![0].slug).toBe("sentinel-model");
  });

  it("skips endpoint returning empty models array", async () => {
    let callCount = 0;
    const transport = createMockTransport(vi.fn(async () => {
      callCount++;
      if (callCount === 1) return { status: 200, body: JSON.stringify({ models: [] }) };
      return { status: 200, body: JSON.stringify({ models: [{ slug: "found" }] }) };
    }));

    const result = await fetchModels({ ...headers }, null, apiConfig, transport);
    expect(result).toHaveLength(1);
    expect(result![0].slug).toBe("found");
  });

  it("sets Accept headers", async () => {
    const mockGet = vi.fn(async () => ({
      status: 200,
      body: JSON.stringify({ models: [{ slug: "test" }] }),
    }));
    const transport = createMockTransport(mockGet);

    await fetchModels({ ...headers }, null, apiConfig, transport);
    const calledHeaders = mockGet.mock.calls[0][1] as Record<string, string>;
    expect(calledHeaders["Accept"]).toBe("application/json");
    expect(calledHeaders["Accept-Encoding"]).toBe("gzip, deflate");
  });
});

// ── probeEndpoint ────────────────────────────────────────────────

describe("probeEndpoint", () => {
  it("returns parsed JSON on success", async () => {
    const transport = createMockTransport(vi.fn(async () => ({
      status: 200,
      body: JSON.stringify({ key: "value", count: 42 }),
    })));

    const result = await probeEndpoint(
      "/v1/status",
      { ...headers },
      null,
      "https://api.example.com",
      transport,
    );
    expect(result).toEqual({ key: "value", count: 42 });
  });

  it("returns null on error", async () => {
    const transport = createMockTransport(vi.fn(async () => {
      throw new Error("timeout");
    }));

    const result = await probeEndpoint(
      "/v1/status",
      { ...headers },
      null,
      "https://api.example.com",
      transport,
    );
    expect(result).toBeNull();
  });
});
