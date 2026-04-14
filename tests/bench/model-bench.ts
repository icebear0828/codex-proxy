#!/usr/bin/env npx tsx
/**
 * Model speed benchmark — compare two models with identical JSON schema output,
 * same seed, temperature=0 for deterministic comparison.
 *
 * Usage:
 *   npx tsx tests/model-bench.ts                                          # default: gpt-5.4-fast vs gpt-5.4, 5 rounds
 *   npx tsx tests/model-bench.ts gpt-5.4-fast gpt-5.4 10                 # custom models + rounds
 *   npx tsx tests/model-bench.ts --account user@example.com               # isolate single account (auto disable/restore others)
 *   npx tsx tests/model-bench.ts --account user@example.com --base-url http://host:port
 */

// ── Types ──────────────────────────────────────────────────────────

interface RoundResult {
  model: string;
  round: number;
  success: boolean;
  status: number;
  ttfbMs: number;
  totalMs: number;
  promptTokens: number;
  completionTokens: number;
  tokensPerSec: number;
  content: string;
  error: string | null;
}

interface ModelStats {
  model: string;
  rounds: number;
  successes: number;
  avgTtfb: number;
  minTtfb: number;
  maxTtfb: number;
  p50Ttfb: number;
  avgTotal: number;
  minTotal: number;
  maxTotal: number;
  p50Total: number;
  avgTps: number;
  minTps: number;
  maxTps: number;
  p50Tps: number;
  avgPromptTokens: number;
  avgCompletionTokens: number;
}

// ── Config ─────────────────────────────────────────────────────────

interface BenchConfig {
  modelA: string;
  modelB: string;
  rounds: number;
  baseUrl: string;
  accountEmail: string | null;
}

function parseArgs(): BenchConfig {
  const args = process.argv.slice(2);
  let baseUrl = "http://localhost:8080";
  let accountEmail: string | null = null;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--base-url" && args[i + 1]) {
      baseUrl = args[i + 1];
      i++;
    } else if (args[i] === "--account" && args[i + 1]) {
      accountEmail = args[i + 1];
      i++;
    } else {
      positional.push(args[i]);
    }
  }

  return {
    modelA: positional[0] || "gpt-5.4-fast",
    modelB: positional[1] || "gpt-5.4",
    rounds: parseInt(positional[2] || "5", 10),
    baseUrl,
    accountEmail,
  };
}

const config = parseArgs();
const { modelA, modelB, rounds: ROUNDS, baseUrl: BASE_URL, accountEmail } = config;
const API_KEY = "pwd";
const SEED = 42;
const TIMEOUT_MS = 180_000;

// ── Account Isolation ─────────────────────────────────────────────

interface AccountInfo {
  id: string;
  email: string | null;
  status: string;
}

async function fetchAllAccounts(): Promise<AccountInfo[]> {
  const res = await fetch(`${BASE_URL}/auth/accounts`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  if (!res.ok) throw new Error(`GET /auth/accounts failed: ${res.status}`);
  const body = (await res.json()) as {
    accounts: Array<{ id: string; email: string | null; status: string }>;
  };
  return body.accounts.map((a) => ({ id: a.id, email: a.email, status: a.status }));
}

async function setAccountStatus(ids: string[], status: "active" | "disabled"): Promise<void> {
  if (ids.length === 0) return;
  const res = await fetch(`${BASE_URL}/auth/accounts/batch-status`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ids, status }),
  });
  if (!res.ok) throw new Error(`batch-status ${status} failed: ${res.status}`);
}

/** Disable all accounts except the target, return IDs that were disabled for restore. */
async function isolateAccount(email: string): Promise<{ targetId: string; disabledIds: string[] }> {
  const accounts = await fetchAllAccounts();
  const target = accounts.find((a) => a.email === email);
  if (!target) {
    const available = accounts.map((a) => a.email).filter(Boolean).join(", ");
    throw new Error(`Account "${email}" not found. Available: ${available}`);
  }

  // Disable other active accounts
  const othersToDisable = accounts
    .filter((a) => a.id !== target.id && a.status === "active")
    .map((a) => a.id);

  if (othersToDisable.length > 0) {
    await setAccountStatus(othersToDisable, "disabled");
    console.log(`   Disabled ${othersToDisable.length} other accounts`);
  }

  // Ensure target is active
  if (target.status !== "active") {
    await setAccountStatus([target.id], "active");
    console.log(`   Enabled target account ${email}`);
  }

  console.log(`   Isolated: ${email} (${target.id.slice(0, 8)}…)`);
  return { targetId: target.id, disabledIds: othersToDisable };
}

/** Restore previously disabled accounts back to active. */
async function restoreAccounts(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await setAccountStatus(ids, "active");
  console.log(`\n♻  Restored ${ids.length} accounts to active`);
}

// ── JSON Schema ────────────────────────────────────────────────────
// Non-trivial schema: analyze a code snippet and return structured output.
// Forces the model to do real reasoning + fill multiple typed fields.

const RESPONSE_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "code_review",
    strict: true,
    schema: {
      type: "object",
      properties: {
        language: {
          type: "string",
          description: "Programming language of the code",
        },
        summary: {
          type: "string",
          description: "One-sentence summary of what the code does",
        },
        complexity: {
          type: "string",
          enum: ["trivial", "simple", "moderate", "complex", "very_complex"],
          description: "Complexity rating",
        },
        issues: {
          type: "array",
          items: {
            type: "object",
            properties: {
              severity: {
                type: "string",
                enum: ["info", "warning", "error", "critical"],
              },
              line: { type: "number" },
              message: { type: "string" },
              suggestion: { type: "string" },
            },
            required: ["severity", "line", "message", "suggestion"],
            additionalProperties: false,
          },
          description: "List of issues found",
        },
        metrics: {
          type: "object",
          properties: {
            lines_of_code: { type: "number" },
            cyclomatic_complexity: { type: "number" },
            maintainability_score: {
              type: "number",
              description: "0-100 score",
            },
          },
          required: ["lines_of_code", "cyclomatic_complexity", "maintainability_score"],
          additionalProperties: false,
        },
        refactored_code: {
          type: "string",
          description: "Improved version of the code",
        },
      },
      required: ["language", "summary", "complexity", "issues", "metrics", "refactored_code"],
      additionalProperties: false,
    },
  },
};

const CODE_SNIPPET = `\
function processOrders(orders, discount) {
  var result = [];
  for (var i = 0; i < orders.length; i++) {
    var order = orders[i];
    if (order.status == "active") {
      var total = 0;
      for (var j = 0; j < order.items.length; j++) {
        total = total + order.items[j].price * order.items[j].qty;
      }
      if (discount > 0) {
        total = total - (total * discount / 100);
      }
      order.total = total;
      order.processed = true;
      result.push(order);
    }
  }
  return result;
}`;

const SYSTEM_PROMPT = "You are a code review assistant. Analyze the given code and return a structured review.";
const USER_PROMPT = `Review this JavaScript function:\n\n\`\`\`javascript\n${CODE_SNIPPET}\n\`\`\``;

// ── Request ────────────────────────────────────────────────────────

async function runStreamingRequest(model: string, round: number): Promise<RoundResult> {
  const start = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let ttfbMs = 0;

  try {
    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: USER_PROMPT },
        ],
        temperature: 0,
        seed: SEED,
        response_format: RESPONSE_SCHEMA,
        stream: true,
      }),
      signal: controller.signal,
    });

    ttfbMs = Math.round(performance.now() - start);

    if (!res.ok) {
      let errorMsg = `HTTP ${res.status}`;
      try {
        const errBody = (await res.json()) as { error?: { message?: string } };
        if (errBody.error?.message) errorMsg = errBody.error.message;
      } catch { /* use default */ }
      return makeError(model, round, res.status, ttfbMs, errorMsg);
    }

    // Consume SSE stream
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let promptTokens = 0;
    let completionTokens = 0;
    let firstChunkTime = 0;

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
          if (raw === "[DONE]") continue;

          try {
            const chunk = JSON.parse(raw) as {
              choices?: Array<{ delta?: { content?: string } }>;
              usage?: { prompt_tokens: number; completion_tokens: number };
            };
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) {
              if (!firstChunkTime) firstChunkTime = performance.now();
              content += delta;
            }
            if (chunk.usage) {
              promptTokens = chunk.usage.prompt_tokens;
              completionTokens = chunk.usage.completion_tokens;
            }
          } catch { /* skip */ }
        }
      }
    }

    const totalMs = Math.round(performance.now() - start);
    // Use first content chunk as TTFB if available (more accurate than HTTP response time)
    const effectiveTtfb = firstChunkTime ? Math.round(firstChunkTime - start) : ttfbMs;
    const generationMs = totalMs - effectiveTtfb;
    const tps = generationMs > 0 ? Math.round((completionTokens / generationMs) * 1000 * 10) / 10 : 0;

    return {
      model,
      round,
      success: true,
      status: 200,
      ttfbMs: effectiveTtfb,
      totalMs,
      promptTokens,
      completionTokens,
      tokensPerSec: tps,
      content: content.slice(0, 100),
      error: null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return makeError(model, round, 0, ttfbMs, msg);
  } finally {
    clearTimeout(timer);
  }
}

function makeError(model: string, round: number, status: number, ttfbMs: number, error: string): RoundResult {
  return {
    model, round, success: false, status, ttfbMs,
    totalMs: ttfbMs, promptTokens: 0, completionTokens: 0,
    tokensPerSec: 0, content: "", error,
  };
}

// ── Stats ──────────────────────────────────────────────────────────

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function computeStats(results: RoundResult[]): ModelStats {
  const ok = results.filter((r) => r.success);
  const ttfbs = ok.map((r) => r.ttfbMs);
  const totals = ok.map((r) => r.totalMs);
  const tps = ok.map((r) => r.tokensPerSec);
  const avg = (arr: number[]) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;

  return {
    model: results[0]?.model ?? "?",
    rounds: results.length,
    successes: ok.length,
    avgTtfb: avg(ttfbs), minTtfb: ttfbs.length ? Math.min(...ttfbs) : 0, maxTtfb: ttfbs.length ? Math.max(...ttfbs) : 0, p50Ttfb: percentile(ttfbs, 50),
    avgTotal: avg(totals), minTotal: totals.length ? Math.min(...totals) : 0, maxTotal: totals.length ? Math.max(...totals) : 0, p50Total: percentile(totals, 50),
    avgTps: Math.round(tps.length ? tps.reduce((a, b) => a + b, 0) / tps.length * 10 : 0) / 10,
    minTps: tps.length ? Math.round(Math.min(...tps) * 10) / 10 : 0,
    maxTps: tps.length ? Math.round(Math.max(...tps) * 10) / 10 : 0,
    p50Tps: Math.round(percentile(tps, 50) * 10) / 10,
    avgPromptTokens: avg(ok.map((r) => r.promptTokens)),
    avgCompletionTokens: avg(ok.map((r) => r.completionTokens)),
  };
}

// ── Output ─────────────────────────────────────────────────────────

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}
function rpad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : " ".repeat(n - s.length) + s;
}

function printRoundTable(results: RoundResult[]): void {
  console.log(`\n ${pad("Round", 6)} ${pad("Model", 20)} ${rpad("TTFB", 8)} ${rpad("Total", 8)} ${rpad("Tok/s", 8)} ${rpad("Prompt", 7)} ${rpad("Compl", 7)}  Status`);
  console.log(" " + "─".repeat(80));

  for (const r of results) {
    const round = pad(`#${r.round + 1}`, 6);
    const model = pad(r.model, 20);
    const ttfb = rpad(`${r.ttfbMs}ms`, 8);
    const total = rpad(`${r.totalMs}ms`, 8);
    const tps = rpad(r.tokensPerSec > 0 ? `${r.tokensPerSec}` : "-", 8);
    const prompt = rpad(r.promptTokens > 0 ? String(r.promptTokens) : "-", 7);
    const compl = rpad(r.completionTokens > 0 ? String(r.completionTokens) : "-", 7);
    const status = r.success ? "OK" : `ERR: ${r.error?.slice(0, 40)}`;
    console.log(` ${round} ${model} ${ttfb} ${total} ${tps} ${prompt} ${compl}  ${status}`);
  }
}

function printComparison(a: ModelStats, b: ModelStats): void {
  const pct = (base: number, compare: number) => {
    if (base === 0) return "N/A";
    const diff = ((compare - base) / base) * 100;
    const sign = diff > 0 ? "+" : "";
    return `${sign}${diff.toFixed(1)}%`;
  };

  console.log("\n── Comparison ──────────────────────────────────────────");
  console.log(` ${"".padEnd(20)} ${rpad(a.model, 18)} ${rpad(b.model, 18)}  Diff`);
  console.log(" " + "─".repeat(75));

  const rows: Array<[string, string, string, string]> = [
    ["Success rate", `${a.successes}/${a.rounds}`, `${b.successes}/${b.rounds}`, ""],
    ["TTFB (avg)", `${a.avgTtfb}ms`, `${b.avgTtfb}ms`, pct(a.avgTtfb, b.avgTtfb)],
    ["TTFB (p50)", `${a.p50Ttfb}ms`, `${b.p50Ttfb}ms`, pct(a.p50Ttfb, b.p50Ttfb)],
    ["TTFB (min/max)", `${a.minTtfb}/${a.maxTtfb}ms`, `${b.minTtfb}/${b.maxTtfb}ms`, ""],
    ["Total (avg)", `${a.avgTotal}ms`, `${b.avgTotal}ms`, pct(a.avgTotal, b.avgTotal)],
    ["Total (p50)", `${a.p50Total}ms`, `${b.p50Total}ms`, pct(a.p50Total, b.p50Total)],
    ["Total (min/max)", `${a.minTotal}/${a.maxTotal}ms`, `${b.minTotal}/${b.maxTotal}ms`, ""],
    ["Tok/s (avg)", `${a.avgTps}`, `${b.avgTps}`, pct(b.avgTps, a.avgTps)],
    ["Tok/s (p50)", `${a.p50Tps}`, `${b.p50Tps}`, ""],
    ["Tok/s (min/max)", `${a.minTps}/${a.maxTps}`, `${b.minTps}/${b.maxTps}`, ""],
    ["Prompt tokens", `${a.avgPromptTokens}`, `${b.avgPromptTokens}`, ""],
    ["Completion tokens", `${a.avgCompletionTokens}`, `${b.avgCompletionTokens}`, ""],
  ];

  for (const [label, va, vb, diff] of rows) {
    console.log(` ${pad(label, 20)} ${rpad(va, 18)} ${rpad(vb, 18)}  ${diff}`);
  }
}

// ── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n⏱  Model Speed Benchmark`);
  console.log(`   Models: ${modelA} vs ${modelB}`);
  console.log(`   Rounds: ${ROUNDS} per model (interleaved)`);
  console.log(`   Schema: JSON (code_review, 6 fields)`);
  console.log(`   Seed: ${SEED} | Temperature: 0`);
  console.log(`   Proxy: ${BASE_URL}`);
  console.log(`   Account: ${accountEmail ?? "(all — no isolation)"}\n`);

  // ── Account isolation ──
  let disabledIds: string[] = [];
  if (accountEmail) {
    console.log(`🔒 Isolating account: ${accountEmail}`);
    const isolation = await isolateAccount(accountEmail);
    disabledIds = isolation.disabledIds;
    console.log("");
  }

  try {
    const allResults: RoundResult[] = [];

    // Interleave A/B to reduce temporal bias
    for (let i = 0; i < ROUNDS; i++) {
      console.log(`── Round ${i + 1}/${ROUNDS} ──`);

      // Alternate which model goes first to reduce ordering bias
      const first = i % 2 === 0 ? modelA : modelB;
      const second = i % 2 === 0 ? modelB : modelA;

      console.log(`  → ${first}...`);
      const r1 = await runStreamingRequest(first, i);
      allResults.push(r1);
      console.log(`    ${r1.success ? `${r1.totalMs}ms, ${r1.tokensPerSec} tok/s` : `ERR: ${r1.error}`}`);

      console.log(`  → ${second}...`);
      const r2 = await runStreamingRequest(second, i);
      allResults.push(r2);
      console.log(`    ${r2.success ? `${r2.totalMs}ms, ${r2.tokensPerSec} tok/s` : `ERR: ${r2.error}`}`);
    }

    // Split results by model
    const resultsA = allResults.filter((r) => r.model === modelA);
    const resultsB = allResults.filter((r) => r.model === modelB);

    printRoundTable(allResults);

    const statsA = computeStats(resultsA);
    const statsB = computeStats(resultsB);
    printComparison(statsA, statsB);

    console.log("");
  } finally {
    // Always restore accounts, even on error
    if (disabledIds.length > 0) {
      await restoreAccounts(disabledIds);
    }
  }
}

main().catch((err) => {
  console.error("\n❌ Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
