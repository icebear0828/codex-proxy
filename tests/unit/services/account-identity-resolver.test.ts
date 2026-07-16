import { describe, expect, it, vi } from "vitest";
import type { CodexTokenMetadata } from "@src/auth/token-metadata.js";
import type { TlsTransport } from "@src/tls/transport.js";
import {
  discoverCodexAccountIdentity,
  parseAccountIdentityResponse,
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

  it("rejects non-success responses without including the upstream body", async () => {
    const transport = {
      get: vi.fn(async () => ({ status: 403, body: "sensitive upstream body" })),
      isImpersonate: () => true,
    } as unknown as TlsTransport;

    await expect(discoverCodexAccountIdentity("secret-token", current, {
      baseUrl: "https://chatgpt.example/backend-api",
      headers: { Authorization: "Bearer [redacted]" },
      transport,
    })).rejects.toThrow("HTTP 403");
  });
});
