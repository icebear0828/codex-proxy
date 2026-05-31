import { beforeEach, describe, expect, it, vi } from "vitest";

const mockConfig = {
  server: { proxy_api_key: null as string | null },
  auth: {
    rotation_strategy: "least_used" as const,
    rate_limit_backoff_seconds: 60,
  },
};

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => mockConfig),
}));

import { AccountPool } from "@src/auth/account-pool.js";
import { createMessagesRoutes } from "@src/routes/messages.js";

function countTokensBody() {
  return {
    model: "gpt-5.5",
    messages: [{ role: "user", content: "count only" }],
  };
}

describe("messages count_tokens route", () => {
  beforeEach(() => {
    mockConfig.server.proxy_api_key = null;
  });

  it("requires proxy API key when configured", async () => {
    mockConfig.server.proxy_api_key = "proxy-secret";
    const pool = new AccountPool();
    const app = createMessagesRoutes(pool);

    try {
      const rejected = await app.request("/v1/messages/count_tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(countTokensBody()),
      });
      expect(rejected.status).toBe(401);

      const accepted = await app.request("/v1/messages/count_tokens?beta=true", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer proxy-secret",
        },
        body: JSON.stringify(countTokensBody()),
      });
      expect(accepted.status).toBe(200);

      const body = await accepted.json() as { input_tokens?: unknown };
      expect(typeof body.input_tokens).toBe("number");
    } finally {
      pool.destroy();
    }
  });
});
