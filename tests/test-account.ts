#!/usr/bin/env npx tsx
/**
 * Test a single account by email — directly hits upstream Codex API,
 * bypassing proxy rotation, to verify the token is valid.
 *
 * Usage:
 *   npx tsx tests/test-account.ts user@example.com
 *   npx tsx tests/test-account.ts user@example.com gpt-5.2-codex
 *   npx tsx tests/test-account.ts --all              # test all accounts
 *   npx tsx tests/test-account.ts --all --parallel 5  # 5 concurrent
 */

// ── Types ──────────────────────────────────────────────────────────

interface AccountDetail {
  id: string;
  email: string | null;
  accountId: string | null;
  status: string;
  planType: string | null;
  token: string;
}

interface TestResult {
  email: string;
  accountId: string | null;
  planType: string | null;
  status: string;
  ok: boolean;
  latencyMs: number;
  content: string;
  error: string | null;
}

// ── Config ─────────────────────────────────────────────────────────

const PROXY_URL = process.env.PROXY_URL || "http://localhost:8080";
const API_KEY = process.env.PROXY_API_KEY || "pwd";
const CODEX_BASE = "https://chatgpt.com/backend-api";
const TIMEOUT_MS = 30_000;

// ── CLI ────────────────────────────────────────────────────────────

function parseArgs(): { emails: string[]; model: string; all: boolean; parallel: number } {
  const args = process.argv.slice(2);
  let model = "gpt-5.2-codex";
  let all = false;
  let parallel = 3;
  const emails: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--all") {
      all = true;
    } else if (args[i] === "--parallel" && args[i + 1]) {
      parallel = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--model" && args[i + 1]) {
      model = args[i + 1];
      i++;
    } else if (!args[i].startsWith("--")) {
      // First positional arg could be email or model
      if (emails.length === 0 && !all) {
        emails.push(args[i]);
      } else if (emails.length === 1 && !args[i].includes("@")) {
        model = args[i];
      } else {
        emails.push(args[i]);
      }
    }
  }

  if (!all && emails.length === 0) {
    console.error("Usage: npx tsx tests/test-account.ts <email> [model]");
    console.error("       npx tsx tests/test-account.ts --all [--parallel N]");
    process.exit(1);
  }

  return { emails, model, all, parallel };
}

// ── Helpers ────────────────────────────────────────────────────────

async function fetchAccountDetails(emails?: string[]): Promise<AccountDetail[]> {
  // Need both endpoints: /auth/accounts for accountId, /auth/accounts/export for token
  const [infoRes, exportRes] = await Promise.all([
    fetch(`${PROXY_URL}/auth/accounts`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    }),
    fetch(`${PROXY_URL}/auth/accounts/export`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    }),
  ]);

  if (!infoRes.ok) throw new Error(`GET /auth/accounts failed: ${infoRes.status}`);
  if (!exportRes.ok) throw new Error(`GET /auth/accounts/export failed: ${exportRes.status}`);

  const info = (await infoRes.json()) as {
    accounts: Array<{
      id: string;
      email: string | null;
      accountId: string | null;
      status: string;
      planType: string | null;
    }>;
  };
  const exported = (await exportRes.json()) as {
    accounts: Array<{ id: string; token: string }>;
  };

  const tokenMap = new Map(exported.accounts.map((a) => [a.id, a.token]));

  let accounts = info.accounts.map((a) => ({
    id: a.id,
    email: a.email,
    accountId: a.accountId,
    status: a.status,
    planType: a.planType,
    token: tokenMap.get(a.id) ?? "",
  }));

  if (emails && emails.length > 0) {
    const emailSet = new Set(emails.map((e) => e.toLowerCase()));
    accounts = accounts.filter((a) => a.email && emailSet.has(a.email.toLowerCase()));
    const found = new Set(accounts.map((a) => a.email?.toLowerCase()));
    for (const e of emailSet) {
      if (!found.has(e)) console.warn(`  Account not found: ${e}`);
    }
  }

  return accounts;
}

async function testAccount(account: AccountDetail, model: string): Promise<TestResult> {
  const start = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${CODEX_BASE}/codex/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${account.token}`,
        "Content-Type": "application/json",
        ...(account.accountId ? { "ChatGPT-Account-Id": account.accountId } : {}),
      },
      body: JSON.stringify({
        model,
        store: false,
        stream: true,
        instructions: "Be brief",
        input: [{ role: "user", content: [{ type: "input_text", text: "Say hi" }] }],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const latencyMs = Math.round(performance.now() - start);
      let errorMsg = `HTTP ${res.status}`;
      try {
        const body = await res.text();
        const parsed = JSON.parse(body) as { detail?: string; error?: { message?: string } };
        errorMsg = parsed.detail ?? parsed.error?.message ?? body.slice(0, 200);
      } catch { /* use default */ }
      return {
        email: account.email ?? account.id,
        accountId: account.accountId,
        planType: account.planType,
        status: account.status,
        ok: false,
        latencyMs,
        content: "",
        error: `${res.status}: ${errorMsg}`,
      };
    }

    // Parse SSE stream for content
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split("\n\n");
      buffer = parts.pop()!;

      for (const part of parts) {
        for (const line of part.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6);
          try {
            const evt = JSON.parse(raw) as {
              type?: string;
              delta?: string;
              text?: string;
            };
            if (evt.type === "response.output_text.delta" && evt.delta) {
              content += evt.delta;
            }
          } catch { /* skip */ }
        }
      }
    }

    const latencyMs = Math.round(performance.now() - start);
    return {
      email: account.email ?? account.id,
      accountId: account.accountId,
      planType: account.planType,
      status: account.status,
      ok: true,
      latencyMs,
      content: content.trim(),
      error: null,
    };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - start);
    return {
      email: account.email ?? account.id,
      accountId: account.accountId,
      planType: account.planType,
      status: account.status,
      ok: false,
      latencyMs,
      content: "",
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── Batch runner ───────────────────────────────────────────────────

async function runBatch(
  accounts: AccountDetail[],
  model: string,
  parallel: number,
): Promise<TestResult[]> {
  const results: TestResult[] = [];
  for (let i = 0; i < accounts.length; i += parallel) {
    const batch = accounts.slice(i, i + parallel);
    const batchResults = await Promise.allSettled(
      batch.map((a) => testAccount(a, model)),
    );
    for (const r of batchResults) {
      results.push(
        r.status === "fulfilled"
          ? r.value
          : {
              email: "?",
              accountId: null,
              planType: null,
              status: "?",
              ok: false,
              latencyMs: 0,
              content: "",
              error: r.reason instanceof Error ? r.reason.message : String(r.reason),
            },
      );
    }
    if (i + parallel < accounts.length) {
      process.stdout.write(`  Tested ${results.length}/${accounts.length}...\r`);
    }
  }
  return results;
}

// ── Output ─────────────────────────────────────────────────────────

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}
function rpad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : " ".repeat(n - s.length) + s;
}

function printResults(results: TestResult[]): void {
  if (results.length === 1) {
    const r = results[0];
    console.log(`\n${r.ok ? "✅" : "❌"} ${r.email}`);
    console.log(`   Plan: ${r.planType ?? "-"} | Status: ${r.status} | Latency: ${r.latencyMs}ms`);
    if (r.ok) {
      console.log(`   Response: "${r.content}"`);
    } else {
      console.log(`   Error: ${r.error}`);
    }
    return;
  }

  // Table for multiple results
  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.length - okCount;

  console.log(`\n── Results ─────────────────────────────────────────────`);
  console.log(
    ` ${pad("", 2)} ${pad("Email", 36)} ${pad("Plan", 6)} ${rpad("Latency", 8)}  Result`,
  );
  console.log(" " + "─".repeat(76));

  for (const r of results) {
    const icon = r.ok ? "✅" : "❌";
    const email = pad((r.email ?? "?").slice(0, 35), 36);
    const plan = pad(r.planType ?? "-", 6);
    const latency = rpad(`${r.latencyMs}ms`, 8);
    const detail = r.ok ? r.content.slice(0, 30) : (r.error?.slice(0, 50) ?? "unknown");
    console.log(` ${icon} ${email} ${plan} ${latency}  ${detail}`);
  }

  console.log(`\n Summary: ${okCount} OK / ${failCount} FAIL (total ${results.length})`);
}

// ── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { emails, model, all, parallel } = parseArgs();

  console.log(`\n🔍 Testing account(s) → ${CODEX_BASE}`);
  console.log(`   Model: ${model}\n`);

  const accounts = await fetchAccountDetails(all ? undefined : emails);
  if (accounts.length === 0) {
    console.error("❌ No matching accounts found");
    process.exit(1);
  }

  const activeAccounts = all ? accounts.filter((a) => a.status === "active") : accounts;
  console.log(`   ${activeAccounts.length} account(s) to test${all ? ` (parallel: ${parallel})` : ""}\n`);

  const results = activeAccounts.length === 1
    ? [await testAccount(activeAccounts[0], model)]
    : await runBatch(activeAccounts, model, parallel);

  printResults(results);
}

main().catch((err) => {
  console.error("\n❌ Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
