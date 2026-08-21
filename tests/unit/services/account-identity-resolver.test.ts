import { describe, expect, it, vi } from "vitest";
import type { CodexTokenMetadata } from "@src/auth/token-metadata.js";
import type { TlsTransport } from "@src/tls/transport.js";
import {
  discoverCodexAccountIdentity,
  parseAccountIdentityResponse,
  parseUsageIdentityResponse,
} from "@src/services/account-identity-resolver.js";

const current: CodexTokenMetadata = {
  accountId: null,
  organizationId: "org-portable",
  userId: "user-portable",
  email: "portable@example.com",
  planType: "plus",
  accountIdSource: null,
};

function accountRecord(accountId: string, userId: string, active = true) {
  return {
    account: {
      account_id: accountId,
      account_owner_id: userId,
      organization_id: null,
      plan_type: "plus",
    },
    entitlement: {
      has_active_subscription: active,
      subscription_plan: "chatgptplusplan",
    },
  };
}

describe("account identity resolver", () => {
  it("extracts the real workspace ID from the default account response", () => {
    const record = accountRecord("workspace-12345678", "user-portable");
    const result = parseAccountIdentityResponse({
      accounts: {
        "workspace-12345678": record,
        default: record,
      },
      account_ordering: ["workspace-12345678"],
    }, current);

    expect(result).toEqual({
      ...current,
      accountId: "workspace-12345678",
      accountIdSource: "upstream_discovery",
    });
  });

  it("uses a matching trusted account hint without ever promoting organizationId", () => {
    const result = parseAccountIdentityResponse({
      accounts: {
        default: accountRecord("workspace-default", "user-portable"),
        "workspace-hinted": accountRecord("workspace-hinted", "user-portable"),
      },
    }, current, "workspace-hinted");

    expect(result?.accountId).toBe("workspace-hinted");
    expect(result?.organizationId).toBe("org-portable");
    expect(result?.accountId).not.toBe(result?.organizationId);
  });

  it("does not let an untrusted hint override the token-derived owner", () => {
    const result = parseAccountIdentityResponse({
      accounts: {
        default: accountRecord("workspace-owned", "user-portable"),
        "workspace-other": accountRecord("workspace-other", "different-user"),
      },
    }, current, "workspace-other");

    expect(result?.accountId).toBe("workspace-owned");
  });

  it("parses an opaque upstream usage account ID without requiring UUID shape", () => {
    const result = parseUsageIdentityResponse({
      account_id: "opaque-account-id-123456789",
      user_id: "user-from-usage",
      email: "usage@example.com",
      plan_type: "plus",
    }, current);

    expect(result).toEqual({
      ...current,
      accountId: "opaque-account-id-123456789",
      userId: "user-from-usage",
      email: "usage@example.com",
      accountIdSource: "upstream_discovery",
    });
  });

  it("performs one GET and returns only parsed identity metadata", async () => {
    const get = vi.fn(async () => ({
      status: 200,
      body: JSON.stringify({
        accounts: {
          default: accountRecord("workspace-network", "user-portable"),
        },
      }),
    }));
    const transport = {
      get,
      isImpersonate: () => true,
    } as unknown as TlsTransport;

    const result = await discoverCodexAccountIdentity("secret-token", current, {
      baseUrl: "https://chatgpt.example/backend-api",
      proxyUrl: "http://127.0.0.1:7897",
      headers: { Authorization: "Bearer [redacted]" },
      transport,
    });

    expect(result.accountId).toBe("workspace-network");
    expect(result.accountIdSource).toBe("upstream_discovery");
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][0]).toContain("/accounts/check/v4-2023-04-27");
  });

  it("falls back to two-step usage verification after account-check HTTP 403", async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ status: 403, body: "sensitive identity body" })
      .mockResolvedValueOnce({
        status: 200,
        body: JSON.stringify({
          account_id: "opaque-account-id-123456789",
          user_id: "user-portable",
          plan_type: "plus",
        }),
      })
      .mockResolvedValueOnce({
        status: 200,
        body: JSON.stringify({
          account_id: "opaque-account-id-123456789",
          user_id: "user-portable",
          plan_type: "plus",
        }),
      });
    const transport = {
      get,
      isImpersonate: () => true,
    } as unknown as TlsTransport;

    const result = await discoverCodexAccountIdentity("secret-token", current, {
      baseUrl: "https://chatgpt.example/backend-api",
      headers: {
        Authorization: "Bearer [redacted]",
        "ChatGPT-Account-Id": "untrusted-stale-id",
      },
      transport,
    });

    expect(result.accountId).toBe("opaque-account-id-123456789");
    expect(result.accountIdSource).toBe("upstream_discovery");
    expect(get).toHaveBeenCalledTimes(3);
    expect(get.mock.calls[1][0]).toContain("/wham/usage");
    expect(get.mock.calls[1][1]).not.toHaveProperty("ChatGPT-Account-Id");
    expect(get.mock.calls[2][1]).toMatchObject({
      "ChatGPT-Account-Id": "opaque-account-id-123456789",
    });
  });

  it("retries one transient usage transport failure before verification", async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ status: 403, body: "identity denied" })
      .mockRejectedValueOnce(new Error("temporary TLS close"))
      .mockResolvedValueOnce({
        status: 200,
        body: JSON.stringify({ account_id: "opaque-account-id-123456789" }),
      })
      .mockResolvedValueOnce({
        status: 200,
        body: JSON.stringify({ account_id: "opaque-account-id-123456789" }),
      });
    const transport = {
      get,
      isImpersonate: () => true,
    } as unknown as TlsTransport;

    const result = await discoverCodexAccountIdentity("secret-token", current, {
      baseUrl: "https://chatgpt.example/backend-api",
      headers: { Authorization: "Bearer [redacted]" },
      transport,
    });

    expect(result.accountId).toBe("opaque-account-id-123456789");
    expect(get).toHaveBeenCalledTimes(4);
  });

  it("rejects a mismatched usage verification ID without leaking response bodies", async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ status: 403, body: "sensitive identity body" })
      .mockResolvedValueOnce({
        status: 200,
        body: JSON.stringify({ account_id: "opaque-account-id-123456789" }),
      })
      .mockResolvedValueOnce({
        status: 200,
        body: JSON.stringify({ account_id: "different-account-id-987654321" }),
      });
    const transport = {
      get,
      isImpersonate: () => true,
    } as unknown as TlsTransport;

    const promise = discoverCodexAccountIdentity("secret-token", current, {
      baseUrl: "https://chatgpt.example/backend-api",
      headers: { Authorization: "Bearer [redacted]" },
      transport,
    });

    await expect(promise).rejects.toThrow("different account ID");
    await expect(promise).rejects.not.toThrow("sensitive identity body");
  });

  it("rejects non-success usage fallback without including upstream bodies", async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ status: 403, body: "sensitive identity body" })
      .mockResolvedValueOnce({ status: 502, body: "sensitive usage body" });
    const transport = {
      get,
      isImpersonate: () => true,
    } as unknown as TlsTransport;

    const promise = discoverCodexAccountIdentity("secret-token", current, {
      baseUrl: "https://chatgpt.example/backend-api",
      headers: { Authorization: "Bearer [redacted]" },
      transport,
    });

    await expect(promise).rejects.toThrow("Account identity endpoint returned HTTP 403");
    await expect(promise).rejects.toThrow("Account usage discovery endpoint returned HTTP 502");
    await expect(promise).rejects.not.toThrow("sensitive");
  });
});
