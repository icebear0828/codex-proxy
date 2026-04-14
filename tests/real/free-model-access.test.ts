/**
 * E2E test: verify which models free/team accounts can actually use.
 *
 * Directly calls the Codex backend with account tokens,
 * bypassing the proxy's routing logic entirely.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { loadConfig, getConfig, loadFingerprint } from "@src/config.js";
import { initTransport, getTransport } from "@src/tls/transport.js";
import { buildHeadersWithContentType } from "@src/fingerprint/manager.js";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

interface AccountEntry {
  token: string;
  accountId: string;
  email: string;
  planType: string;
  status: string;
  usage: { rate_limit_until: string | null };
}

let freeAccount: AccountEntry | undefined;
let teamAccount: AccountEntry | undefined;
let ready = false;

beforeAll(async () => {
  await loadConfig();
  await loadFingerprint();
  await initTransport();

  const dataPath = resolve(process.cwd(), "data", "accounts.json");
  if (!existsSync(dataPath)) {
    console.warn("[E2E] accounts.json not found, skipping");
    return;
  }
  const data = JSON.parse(readFileSync(dataPath, "utf-8")) as { accounts: AccountEntry[] };

  freeAccount = data.accounts.find(
    (a) => a.planType === "free" && a.status === "active" && !a.usage?.rate_limit_until,
  );
  teamAccount = data.accounts.find(
    (a) => a.planType === "team" && a.status === "active" && !a.usage?.rate_limit_until,
  );

  console.log("[E2E] free:", freeAccount?.email ?? "none");
  console.log("[E2E] team:", teamAccount?.email ?? "none");
  ready = true;
});

/** Send a minimal /codex/responses request and return status + body text. */
async function sendCodexRequest(
  account: AccountEntry,
  model: string,
): Promise<{ status: number; body: string }> {
  const transport = getTransport();
  const headers = buildHeadersWithContentType(account.token, account.accountId);
  const url = "https://chatgpt.com/backend-api/codex/responses";

  const payload = JSON.stringify({
    model,
    instructions: "Reply with exactly one word: hello",
    input: [{ role: "user", content: [{ type: "input_text", text: "say hello" }] }],
    stream: true,
    store: false,
  });

  const result = await transport.post(url, headers, payload, undefined, 30, null);

  let body: string;
  if (typeof result.body === "string") {
    body = result.body;
  } else if (result.body && typeof (result.body as ReadableStream).getReader === "function") {
    const reader = (result.body as ReadableStream).getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    body = Buffer.concat(chunks).toString("utf-8");
  } else {
    body = String(result.body);
  }

  return { status: result.status, body };
}

describe("free account model access", () => {
  it("free + gpt-5.2-codex (should succeed)", async () => {
    if (!ready || !freeAccount) return; // skip gracefully
    const { status, body } = await sendCodexRequest(freeAccount, "gpt-5.2-codex");
    console.log("[free + gpt-5.2-codex] status:", status, "body:", body.slice(0, 300));
    if (status === 401) {
      console.warn("[free + gpt-5.2-codex] token expired, skipping");
      return;
    }
    expect(status).toBe(200);
  }, 60_000);

  it("free + gpt-5.4 (should succeed — opened to free tier ~2026-03)", async () => {
    if (!ready || !freeAccount) return;
    const { status, body } = await sendCodexRequest(freeAccount, "gpt-5.4");
    console.log("[free + gpt-5.4] status:", status, "body:", body.slice(0, 500));
    if (status === 401) {
      console.warn("[free + gpt-5.4] token expired, skipping");
      return;
    }
    // Previously rejected for free accounts, but OpenAI opened gpt-5.4 to free tier
    expect(status).toBe(200);
  }, 60_000);
});

describe("team account model access", () => {
  it("team + gpt-5.4 (should succeed)", async () => {
    if (!ready || !teamAccount) return;
    const { status, body } = await sendCodexRequest(teamAccount, "gpt-5.4");
    console.log("[team + gpt-5.4] status:", status, "body:", body.slice(0, 300));
    expect(status).toBe(200);
  }, 60_000);

  it("team + gpt-5.2-codex (should succeed)", async () => {
    if (!ready || !teamAccount) return;
    const { status, body } = await sendCodexRequest(teamAccount, "gpt-5.2-codex");
    console.log("[team + gpt-5.2-codex] status:", status, "body:", body.slice(0, 300));
    expect(status).toBe(200);
  }, 60_000);
});
