import { describe, expect, it } from "vitest";
import { createMemoryPersistence } from "@helpers/account-pool-factory.js";
import { createValidJwt } from "@helpers/jwt.js";
import { AccountPool } from "@src/auth/account-pool.js";
import {
  buildAccountExportPayload,
  parseAccountImportPayload,
  parseAccountImportText,
} from "@src/services/account-transfer-formats.js";

function makePool(): AccountPool {
  return new AccountPool({
    persistence: createMemoryPersistence(),
    rotationStrategy: "least_used",
    initialToken: null,
    rateLimitBackoffSeconds: 300,
  });
}

describe("account transfer formats", () => {
  it("parses Cockpit Tools portable token objects", () => {
    const entries = parseAccountImportPayload([
      {
        access_token: "access.jwt.token",
        refresh_token: "rt_portable",
        email: "user@example.com",
      },
      {
        tokens: {
          accessToken: "nested.jwt.token",
          refreshToken: "rt_nested",
        },
        label: "Nested",
      },
    ]);

    expect(entries).toEqual([
      { token: "access.jwt.token", refreshToken: "rt_portable" },
      { token: "nested.jwt.token", refreshToken: "rt_nested", label: "Nested" },
    ]);
  });

  it("parses Sub2API OpenAI OAuth exports", () => {
    const entries = parseAccountImportPayload({
      type: "sub2api-data",
      version: 1,
      proxies: [],
      accounts: [
        {
          name: "Team Alpha",
          platform: "openai",
          type: "oauth",
          credentials: {
            access_token: "sub2api.jwt.token",
            refresh_token: "rt_sub2api",
          },
          concurrency: 0,
          priority: 0,
        },
        {
          name: "Ignored Anthropic",
          platform: "anthropic",
          type: "oauth",
          credentials: { access_token: "anthropic-token" },
        },
      ],
    });

    expect(entries).toEqual([
      {
        token: "sub2api.jwt.token",
        refreshToken: "rt_sub2api",
        label: "Team Alpha",
      },
    ]);
  });

  it("parses text token lines and one-json-object-per-line input", () => {
    const entries = parseAccountImportText([
      "{\"accessToken\":\"json.jwt.token\",\"refreshToken\":\"rt_json\",\"label\":\"JSON\"}",
      "plain.access.token",
      "rt_text_only",
    ].join("\n"));

    expect(entries).toEqual([
      { token: "json.jwt.token", refreshToken: "rt_json", label: "JSON" },
      { token: "plain.access.token" },
      { refreshToken: "rt_text_only" },
    ]);
  });

  it("exports Cockpit Tools, Sub2API, and CPA payloads", () => {
    const pool = makePool();
    const token = createValidJwt({
      accountId: "acct-1",
      userId: "user-1",
      email: "alpha@example.com",
      planType: "plus",
    });
    const entryId = pool.addAccount(token, "rt_alpha");
    pool.setLabel(entryId, "Alpha");
    const entries = pool.getAllEntries();

    const cockpit = buildAccountExportPayload(entries, "cockpit_tools");
    expect(cockpit).toEqual([
      expect.objectContaining({
        access_token: token,
        refresh_token: "rt_alpha",
        account_id: "acct-1",
        email: "alpha@example.com",
        type: "codex",
      }),
    ]);

    const sub2api = buildAccountExportPayload(entries, "sub2api");
    expect(sub2api).toEqual(expect.objectContaining({
      type: "sub2api-data",
      version: 1,
      accounts: [
        expect.objectContaining({
          name: "Alpha",
          platform: "openai",
          type: "oauth",
          credentials: expect.objectContaining({
            access_token: token,
            refresh_token: "rt_alpha",
            chatgpt_account_id: "acct-1",
          }),
        }),
      ],
    }));

    const cpa = buildAccountExportPayload(entries, "cpa");
    expect(cpa).toEqual(expect.objectContaining({
      access_token: token,
      refresh_token: "rt_alpha",
      account_id: "acct-1",
      type: "codex",
    }));
  });
});
