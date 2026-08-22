import { describe, it, expect, vi } from "vitest";

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => ({
    api: { base_url: "https://chatgpt.com/backend-api" },
    client: { app_version: "1.0.0" },
  })),
}));

vi.mock("@src/fingerprint/manager.js", () => ({
  buildHeaders: vi.fn(() => ({ Authorization: "Bearer test-token" })),
  buildHeadersWithContentType: vi.fn(() => ({
    Authorization: "Bearer test-token",
    "Content-Type": "application/json",
  })),
}));

import {
  parseResetCreditsSnapshot,
  fetchResetCredits,
  consumeResetCredit,
} from "@src/proxy/codex-usage.js";
import { CodexApi, CodexApiError } from "@src/proxy/codex-api.js";
import type { TlsTransport } from "@src/tls/transport.js";

describe("parseResetCreditsSnapshot", () => {
  it("parses valid reset credits snapshot with available count and dates", () => {
    const futureSec = Math.floor(Date.now() / 1000) + 3600;
    const pastSec = Math.floor(Date.now() / 1000) - 3600;

    const payload = {
      available_count: 1,
      credits: [
        {
          id: "credit_1",
          status: "available",
          reset_type: "rate_limit",
          granted_at: pastSec,
          expires_at: futureSec,
          redeemed_at: null,
        },
        {
          id: "credit_2",
          status: "redeemed",
          reset_type: "rate_limit",
          granted_at: pastSec - 7200,
          expires_at: pastSec,
          redeemed_at: pastSec - 1000,
        },
      ],
      next_expires_at: futureSec,
    };

    const parsed = parseResetCreditsSnapshot(payload);
    expect(parsed.available_count).toBe(1);
    expect(parsed.credits).toHaveLength(2);
    expect(parsed.credits[0].id).toBe("credit_1");
    expect(parsed.credits[0].status).toBe("available");
    expect(parsed.next_expires_at).toBe(futureSec);
  });

  it("calculates available_count and next_expires_at if omitted from payload", () => {
    const future1 = Math.floor(Date.now() / 1000) + 1800;
    const future2 = Math.floor(Date.now() / 1000) + 7200;

    const payload = {
      credits: [
        {
          id: "c1",
          status: "available",
          expires_at: future2,
        },
        {
          id: "c2",
          status: "available",
          expires_at: future1,
        },
        {
          id: "c3",
          status: "expired",
          expires_at: Math.floor(Date.now() / 1000) - 100,
        },
      ],
    };

    const parsed = parseResetCreditsSnapshot(payload);
    expect(parsed.available_count).toBe(2);
    expect(parsed.next_expires_at).toBe(future1);
  });

  it("handles null or empty payload gracefully", () => {
    expect(parseResetCreditsSnapshot(null)).toEqual({
      credits: [],
      available_count: 0,
      next_expires_at: null,
    });
    expect(parseResetCreditsSnapshot({})).toEqual({
      credits: [],
      available_count: 0,
      next_expires_at: null,
    });
  });
});

describe("fetchResetCredits", () => {
  it("fetches reset credits snapshot from upstream", async () => {
    const futureSec = Math.floor(Date.now() / 1000) + 3600;
    const mockTransport: TlsTransport = {
      isImpersonate: () => false,
      post: vi.fn(),
      simplePost: vi.fn(),
      get: vi.fn().mockResolvedValue({
        status: 200,
        body: JSON.stringify({
          available_count: 2,
          credits: [
            { id: "c1", status: "available", expires_at: futureSec },
          ],
        }),
      }),
    };

    const result = await fetchResetCredits(
      { Authorization: "Bearer test" },
      null,
      "https://chatgpt.com/backend-api",
      mockTransport,
    );

    expect(result.available_count).toBe(2);
    expect(result.credits).toHaveLength(1);
  });

  it("throws CodexApiError when upstream returns 401 or non-200", async () => {
    const mockTransport: TlsTransport = {
      isImpersonate: () => false,
      post: vi.fn(),
      simplePost: vi.fn(),
      get: vi.fn().mockResolvedValue({
        status: 401,
        body: JSON.stringify({ detail: "Token invalid" }),
      }),
    };

    await expect(
      fetchResetCredits(
        { Authorization: "Bearer test" },
        null,
        "https://chatgpt.com/backend-api",
        mockTransport,
      ),
    ).rejects.toThrow(CodexApiError);
  });
});

describe("consumeResetCredit", () => {
  it("sends POST request to consume endpoint with redeem_request_id", async () => {
    const simplePostMock = vi.fn().mockResolvedValue({
      status: 200,
      body: JSON.stringify({ status: "success" }),
    });

    const mockTransport: TlsTransport = {
      isImpersonate: () => false,
      post: vi.fn(),
      simplePost: simplePostMock,
      get: vi.fn(),
    };

    await consumeResetCredit(
      { Authorization: "Bearer test" },
      "test-uuid-1234",
      null,
      "https://chatgpt.com/backend-api",
      mockTransport,
    );

    expect(simplePostMock).toHaveBeenCalledTimes(1);
    const [url, headers, body] = simplePostMock.mock.calls[0];
    expect(url).toContain("/wham/rate-limit-reset-credits/consume");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(body)).toEqual({ redeem_request_id: "test-uuid-1234" });
  });

  it("falls back to next URL when first candidate returns 404", async () => {
    const simplePostMock = vi
      .fn()
      .mockResolvedValueOnce({
        status: 404,
        body: "Not Found",
      })
      .mockResolvedValueOnce({
        status: 200,
        body: JSON.stringify({ status: "success" }),
      });

    const mockTransport: TlsTransport = {
      isImpersonate: () => false,
      post: vi.fn(),
      simplePost: simplePostMock,
      get: vi.fn(),
    };

    await expect(
      consumeResetCredit(
        { Authorization: "Bearer test" },
        "test-uuid-1234",
        null,
        "https://chatgpt.com/backend-api",
        mockTransport,
      ),
    ).resolves.toBeUndefined();

    expect(simplePostMock).toHaveBeenCalledTimes(2);
  });

  it("throws CodexApiError when consume endpoint returns error", async () => {
    const mockTransport: TlsTransport = {
      isImpersonate: () => false,
      post: vi.fn(),
      simplePost: vi.fn().mockResolvedValue({
        status: 400,
        body: JSON.stringify({ detail: { code: "no_credits_available" } }),
      }),
      get: vi.fn(),
    };

    await expect(
      consumeResetCredit(
        { Authorization: "Bearer test" },
        "test-uuid-1234",
        null,
        "https://chatgpt.com/backend-api",
        mockTransport,
      ),
    ).rejects.toThrow(CodexApiError);
  });
});

describe("CodexApi reset credits methods", () => {
  it("getResetCredits and consumeResetCredit invoke transport properly", async () => {
    const mockTransport: TlsTransport = {
      isImpersonate: () => false,
      post: vi.fn(),
      simplePost: vi.fn().mockResolvedValue({ status: 200, body: "{}" }),
      get: vi.fn().mockResolvedValue({
        status: 200,
        body: JSON.stringify({ available_count: 1, credits: [] }),
      }),
    };

    const api = new CodexApi(
      "test-token",
      "test-account-id",
      null,
      null,
      null,
      "https://chatgpt.com/backend-api",
      mockTransport,
    );

    const credits = await api.getResetCredits();
    expect(credits.available_count).toBe(1);

    await expect(api.consumeResetCredit("uuid-5678")).resolves.toBeUndefined();
  });
});
