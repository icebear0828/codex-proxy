#!/usr/bin/env npx tsx
/**
 * Concurrency benchmark — compare single-account vs multi-account latency.
 *
 * Usage:
 *   npx tsx tests/concurrency-bench.ts                    # auto-pick accounts
 *   npx tsx tests/concurrency-bench.ts 3                  # 3 concurrent per test
 *   npx tsx tests/concurrency-bench.ts 3 http://localhost:8080
 */

const N = parseInt(process.argv[2] || "3", 10);
const BASE_URL = process.argv[3] || "http://localhost:8080";
const API_KEY = "pwd";
const MODEL = "gpt-5.2-codex";
const TIMEOUT_MS = 120_000;

interface TimingResult {
  index: number;
  success: boolean;
  status: number;
  ttfbMs: number;
  totalMs: number;
  error: string | null;
}

// ── Helpers ────────────────────────────────────────────────────────

async function fetchActiveAccountIds(): Promise<string[]> {
  const res = await fetch(`${BASE_URL}/auth/accounts`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  if (!res.ok) throw new Error(`GET /auth/accounts failed: ${res.status}`);
  const body = (await res.json()) as {
    accounts: Array<{ id: string; status: string }>;
  };
  return body.accounts.filter((a) => a.status === "active").map((a) => a.id);
}

async function fireOne(index: number): Promise<TimingResult> {
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
        messages: [{ role: "user", content: "Say hi" }],
        stream: true,
        max_tokens: 5,
      }),
      signal: controller.signal,
    });

    const ttfbMs = Math.round(performance.now() - start);

    if (!res.ok) {
      return { index, success: false, status: res.status, ttfbMs, totalMs: ttfbMs, error: `HTTP ${res.status}` };
    }

    // Drain the stream
    const reader = res.body!.getReader();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
    const totalMs = Math.round(performance.now() - start);
    return { index, success: true, status: 200, ttfbMs, totalMs, error: null };
  } catch (err) {
    const ms = Math.round(performance.now() - start);
    return { index, success: false, status: 0, ttfbMs: ms, totalMs: ms, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function setMaxConcurrent(value: number): Promise<void> {
  await fetch(`${BASE_URL}/admin/general-settings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ max_concurrent_per_account: value }),
  });
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function rpad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : " ".repeat(n - s.length) + s;
}

function printResults(label: string, results: TimingResult[], wallMs: number): void {
  console.log(`\n── ${label} ──`);
  for (const r of results.sort((a, b) => a.index - b.index)) {
    const idx = pad(`#${r.index + 1}`, 4);
    const status = r.success ? "OK " : `${r.status}`;
    const ttfb = rpad(`${r.ttfbMs}ms`, 8);
    const total = rpad(`${r.totalMs}ms`, 8);
    const err = r.error ? ` [${r.error.slice(0, 40)}]` : "";
    console.log(` ${idx} ${pad(status, 5)} TTFB=${ttfb} Total=${total}${err}`);
  }

  const ok = results.filter((r) => r.success);
  if (ok.length > 0) {
    const ttfbs = ok.map((r) => r.ttfbMs);
    const totals = ok.map((r) => r.totalMs);
    const avg = (a: number[]) => Math.round(a.reduce((s, v) => s + v, 0) / a.length);
    console.log(` TTFB:  avg=${avg(ttfbs)}ms  min=${Math.min(...ttfbs)}ms  max=${Math.max(...ttfbs)}ms`);
    console.log(` Total: avg=${avg(totals)}ms  min=${Math.min(...totals)}ms  max=${Math.max(...totals)}ms`);
  }
  console.log(` Wall: ${(wallMs / 1000).toFixed(1)}s  OK: ${ok.length}/${results.length}`);
}

// ── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n🔬 Concurrency benchmark: ${N} concurrent → ${BASE_URL}`);
  console.log(`   Model: ${MODEL}\n`);

  // ── Test 1: Multi-account (max_concurrent=1, forces different accounts) ──
  console.log(`⏳ Test 1: ${N} requests → ${N} different accounts (max_concurrent=1)...`);
  await setMaxConcurrent(1);

  const t1Start = performance.now();
  const test1 = await Promise.allSettled(Array.from({ length: N }, (_, i) => fireOne(i)));
  const t1Wall = Math.round(performance.now() - t1Start);
  const r1 = test1.map((s, i) =>
    s.status === "fulfilled" ? s.value : { index: i, success: false, status: 0, ttfbMs: 0, totalMs: 0, error: String(s.reason) },
  );
  printResults(`Test 1: ${N} accounts × 1 concurrent`, r1, t1Wall);

  // ── Test 2: Single-account (max_concurrent=N, forces same account with sticky) ──
  console.log(`\n⏳ Test 2: ${N} requests → 1 account (max_concurrent=${N}, sticky)...`);
  await setMaxConcurrent(N);

  // Temporarily switch to sticky strategy to force same account
  await fetch(`${BASE_URL}/admin/rotation-settings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ rotation_strategy: "sticky" }),
  });

  const t2Start = performance.now();
  const test2 = await Promise.allSettled(Array.from({ length: N }, (_, i) => fireOne(i)));
  const t2Wall = Math.round(performance.now() - t2Start);
  const r2 = test2.map((s, i) =>
    s.status === "fulfilled" ? s.value : { index: i, success: false, status: 0, ttfbMs: 0, totalMs: 0, error: String(s.reason) },
  );
  printResults(`Test 2: 1 account × ${N} concurrent`, r2, t2Wall);

  // ── Restore defaults ──
  await setMaxConcurrent(3);
  await fetch(`${BASE_URL}/admin/rotation-settings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ rotation_strategy: "least_used" }),
  });

  // ── Comparison ──
  const avg1 = r1.filter((r) => r.success);
  const avg2 = r2.filter((r) => r.success);
  if (avg1.length && avg2.length) {
    const a1 = Math.round(avg1.reduce((s, r) => s + r.ttfbMs, 0) / avg1.length);
    const a2 = Math.round(avg2.reduce((s, r) => s + r.ttfbMs, 0) / avg2.length);
    console.log(`\n── Comparison ──`);
    console.log(` Multi-account avg TTFB: ${a1}ms`);
    console.log(` Single-account avg TTFB: ${a2}ms`);
    console.log(` Delta: ${a2 - a1 > 0 ? "+" : ""}${a2 - a1}ms (${a2 > a1 ? "single-account slower" : "single-account faster"})`);
  }
}

main().catch((err) => {
  console.error("\n❌ Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
