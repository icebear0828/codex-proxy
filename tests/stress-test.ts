#!/usr/bin/env npx tsx
/**
 * Stress test — fire N concurrent streaming requests against the live proxy,
 * then diff per-account usage to verify concurrency correctness.
 *
 * Usage:
 *   npx tsx tests/stress-test.ts          # 10 concurrent (default)
 *   npx tsx tests/stress-test.ts 20       # 20 concurrent
 *   npx tsx tests/stress-test.ts 10 http://localhost:8080
 */

// ── Types ──────────────────────────────────────────────────────────

interface AccountUsageSnapshot {
  id: string;
  email: string | null;
  status: string;
  planType: string | null;
  request_count: number;
  input_tokens: number;
  output_tokens: number;
}

interface RequestResult {
  index: number;
  success: boolean;
  status: number;
  ttfbMs: number;
  latencyMs: number;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
  content: string;
  error: string | null;
}

interface AccountDiff {
  id: string;
  email: string | null;
  status: string;
  planType: string | null;
  deltaRequests: number;
  deltaInput: number;
  deltaOutput: number;
}

// ── Config ─────────────────────────────────────────────────────────

const CONCURRENCY = parseInt(process.argv[2] || "10", 10);
const BASE_URL = process.argv[3] || "http://localhost:8080";
const API_KEY = "pwd";
const MODEL = "gpt-5.2-codex";
const TIMEOUT_MS = 120_000;

// ── Helpers ────────────────────────────────────────────────────────

async function fetchAccounts(): Promise<AccountUsageSnapshot[]> {
  const res = await fetch(`${BASE_URL}/auth/accounts`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  if (!res.ok) throw new Error(`GET /auth/accounts failed: ${res.status}`);
  const body = (await res.json()) as {
    accounts: Array<{
      id: string;
      email: string | null;
      status: string;
      planType: string | null;
      usage: {
        request_count: number;
        input_tokens: number;
        output_tokens: number;
      };
    }>;
  };
  return body.accounts.map((a) => ({
    id: a.id,
    email: a.email,
    status: a.status,
    planType: a.planType,
    request_count: a.usage.request_count,
    input_tokens: a.usage.input_tokens,
    output_tokens: a.usage.output_tokens,
  }));
}

async function consumeSSEStream(
  response: Response,
): Promise<{ content: string; usage: RequestResult["usage"] }> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let usage: RequestResult["usage"] = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const parts = buffer.split("\n\n");
    buffer = parts.pop()!;

    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;

      for (const line of trimmed.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6);
        if (raw === "[DONE]") continue;

        try {
          const chunk = JSON.parse(raw) as {
            choices?: Array<{
              delta?: { content?: string };
            }>;
            usage?: {
              prompt_tokens: number;
              completion_tokens: number;
              total_tokens: number;
            };
          };
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) content += delta.content;
          if (chunk.usage) usage = chunk.usage;
        } catch {
          /* skip malformed */
        }
      }
    }
  }

  return { content, usage };
}

async function fireRequest(index: number): Promise<RequestResult> {
  const start = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: "Say hello in one word" }],
        stream: true,
      }),
      signal: controller.signal,
    });

    const ttfbMs = Math.round(performance.now() - start);

    if (!res.ok) {
      let errorMsg = `HTTP ${res.status}`;
      try {
        const errBody = (await res.json()) as {
          error?: { message?: string; code?: string };
        };
        if (errBody.error?.message) {
          errorMsg = `${errBody.error.code ?? res.status}: ${errBody.error.message}`;
        }
      } catch {
        /* use default */
      }
      return {
        index,
        success: false,
        status: res.status,
        ttfbMs,
        latencyMs: ttfbMs,
        usage: null,
        content: "",
        error: errorMsg,
      };
    }

    const { content, usage } = await consumeSSEStream(res);
    const finalLatency = Math.round(performance.now() - start);

    return {
      index,
      success: true,
      status: 200,
      ttfbMs,
      latencyMs: finalLatency,
      usage,
      content: content.trim(),
      error: null,
    };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - start);
    const msg = err instanceof Error ? err.message : String(err);
    return {
      index,
      success: false,
      status: 0,
      ttfbMs: latencyMs,
      latencyMs,
      usage: null,
      content: "",
      error: msg,
    };
  } finally {
    clearTimeout(timer);
  }
}

function diffSnapshots(
  before: AccountUsageSnapshot[],
  after: AccountUsageSnapshot[],
): AccountDiff[] {
  const beforeMap = new Map(before.map((a) => [a.id, a]));
  return after.map((a) => {
    const b = beforeMap.get(a.id);
    return {
      id: a.id,
      email: a.email,
      status: a.status,
      planType: a.planType,
      deltaRequests: a.request_count - (b?.request_count ?? 0),
      deltaInput: a.input_tokens - (b?.input_tokens ?? 0),
      deltaOutput: a.output_tokens - (b?.output_tokens ?? 0),
    };
  });
}

// ── Formatters ─────────────────────────────────────────────────────

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function rpad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : " ".repeat(n - s.length) + s;
}

function printRequestTable(results: RequestResult[]): void {
  console.log("\n── Per-Request Results ──────────────────────────────────");
  console.log(
    ` ${pad("#", 3)} ${pad("Status", 7)} ${rpad("TTFB", 8)} ${rpad("Total", 8)} ${rpad("Prompt", 7)} ${rpad("Compl", 7)}  Content / Error`,
  );
  console.log(" " + "─".repeat(80));

  for (const r of results.sort((a, b) => a.index - b.index)) {
    const idx = pad(String(r.index + 1), 3);
    const status = pad(String(r.status), 7);
    const ttfb = rpad(`${r.ttfbMs}ms`, 8);
    const latency = rpad(`${r.latencyMs}ms`, 8);
    const prompt = r.usage ? rpad(String(r.usage.prompt_tokens), 7) : rpad("-", 7);
    const compl = r.usage ? rpad(String(r.usage.completion_tokens), 7) : rpad("-", 7);
    const text = r.success
      ? r.content.slice(0, 40)
      : `[${r.error?.slice(0, 60) ?? "unknown"}]`;
    console.log(` ${idx} ${status} ${ttfb} ${latency} ${prompt} ${compl}  ${text}`);
  }
}

function printAccountTable(diffs: AccountDiff[]): void {
  const active = diffs.filter((d) => d.deltaRequests > 0 || d.deltaInput > 0 || d.deltaOutput > 0);
  if (active.length === 0) {
    console.log("\n── Per-Account Usage Diff ── (no account changes detected)");
    return;
  }

  console.log("\n── Per-Account Usage Diff ───────────────────────────────");
  console.log(
    ` ${pad("Account", 12)} ${pad("Email", 28)} ${pad("Plan", 6)} ${rpad("+Reqs", 6)} ${rpad("+Input", 8)} ${rpad("+Output", 8)}  Status`,
  );
  console.log(" " + "─".repeat(86));

  for (const d of active.sort((a, b) => b.deltaRequests - a.deltaRequests)) {
    const id = pad(d.id.slice(0, 11), 12);
    const email = pad(d.email?.slice(0, 27) ?? "-", 28);
    const plan = pad(d.planType ?? "-", 6);
    const reqs = rpad(d.deltaRequests > 0 ? `+${d.deltaRequests}` : "0", 6);
    const input = rpad(d.deltaInput > 0 ? `+${d.deltaInput}` : "0", 8);
    const output = rpad(d.deltaOutput > 0 ? `+${d.deltaOutput}` : "0", 8);
    console.log(` ${id} ${email} ${plan} ${reqs} ${input} ${output}  ${d.status}`);
  }
}

function printSummary(results: RequestResult[], diffs: AccountDiff[], elapsedMs: number): void {
  const ok = results.filter((r) => r.success).length;
  const err503 = results.filter((r) => r.status === 503).length;
  const err429 = results.filter((r) => r.status === 429).length;
  const errOther = results.length - ok - err503 - err429;

  const totalPrompt = results.reduce((s, r) => s + (r.usage?.prompt_tokens ?? 0), 0);
  const totalCompl = results.reduce((s, r) => s + (r.usage?.completion_tokens ?? 0), 0);
  const totalTokens = totalPrompt + totalCompl;

  const success = results.filter((r) => r.success);
  const ttfbs = success.map((r) => r.ttfbMs);
  const latencies = success.map((r) => r.latencyMs);

  const avg = (arr: number[]) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;

  const accountsUsed = diffs.filter((d) => d.deltaRequests > 0).length;
  const accountsTotal = diffs.length;

  console.log("\n── Summary ─────────────────────────────────────────────");
  console.log(
    ` Fired: ${results.length} | OK: ${ok} | 503: ${err503} | 429: ${err429} | Other: ${errOther}`,
  );
  console.log(` Total tokens: ${totalTokens} (input: ${totalPrompt}, output: ${totalCompl})`);
  console.log(` TTFB:    avg ${avg(ttfbs)}ms | min ${ttfbs.length ? Math.min(...ttfbs) : 0}ms | max ${ttfbs.length ? Math.max(...ttfbs) : 0}ms`);
  console.log(` Latency: avg ${avg(latencies)}ms | min ${latencies.length ? Math.min(...latencies) : 0}ms | max ${latencies.length ? Math.max(...latencies) : 0}ms`);
  console.log(` Accounts used: ${accountsUsed}/${accountsTotal}`);
  console.log(` Wall time: ${(elapsedMs / 1000).toFixed(1)}s`);
}

// ── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n🔥 Stress test: ${CONCURRENCY} concurrent requests → ${BASE_URL}`);
  console.log(`   Model: ${MODEL}\n`);

  // Phase 1: Snapshot before
  console.log("📸 Snapshotting account usage (before)...");
  const before = await fetchAccounts();
  console.log(`   ${before.length} accounts found (${before.filter((a) => a.status === "active").length} active)`);

  // Phase 2: Fire
  console.log(`\n🚀 Firing ${CONCURRENCY} concurrent requests...`);
  const wallStart = performance.now();
  const settled = await Promise.allSettled(
    Array.from({ length: CONCURRENCY }, (_, i) => fireRequest(i)),
  );
  const wallMs = Math.round(performance.now() - wallStart);

  const results: RequestResult[] = settled.map((s, i) =>
    s.status === "fulfilled"
      ? s.value
      : {
          index: i,
          success: false,
          status: 0,
          latencyMs: 0,
          usage: null,
          content: "",
          error: s.reason instanceof Error ? s.reason.message : String(s.reason),
        },
  );

  // Phase 3: Snapshot after + diff
  console.log("📸 Snapshotting account usage (after)...");
  const after = await fetchAccounts();
  const diffs = diffSnapshots(before, after);

  // Phase 4: Report
  printRequestTable(results);
  printAccountTable(diffs);
  printSummary(results, diffs, wallMs);
}

main().catch((err) => {
  console.error("\n❌ Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
