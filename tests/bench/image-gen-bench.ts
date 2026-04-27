#!/usr/bin/env npx tsx
/**
 * Image generation benchmark — concurrent latency + token cost across
 * the {host model} × {size} matrix.
 *
 * Usage:
 *   npx tsx tests/bench/image-gen-bench.ts                    # 2×2 default
 *   npx tsx tests/bench/image-gen-bench.ts 3 2                # concurrency × rounds
 *   npx tsx tests/bench/image-gen-bench.ts 2 2 http://localhost:8080
 *
 * Premise: at least one Plus+ account must be active in the proxy pool —
 * Free accounts get the image_generation tool silently stripped upstream.
 */

const CONCURRENCY = parseInt(process.argv[2] || "2", 10);
const ROUNDS = parseInt(process.argv[3] || "2", 10);
const BASE_URL = process.argv[4] || "http://localhost:8080";
const API_KEY = process.env.PROXY_API_KEY || "pwd";
const PER_REQUEST_TIMEOUT_MS = 240_000;

const MODELS = ["gpt-5.4-mini", "gpt-5.5"] as const;
const SIZES = ["1024x1024", "3840x2160"] as const;

interface RunResult {
  ok: boolean;
  status: number;
  elapsedMs: number;
  resultBytes: number;
  hostInputTokens: number;
  hostOutputTokens: number;
  hostReasoningTokens: number;
  imageInputTokens: number;
  imageOutputTokens: number;
  error: string | null;
}

async function generate(model: string, size: string): Promise<RunResult> {
  const start = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PER_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        stream: true,
        input: [{ role: "user", content: "Draw a red circle on a white background." }],
        tools: [{ type: "image_generation", size }],
      }),
      signal: ctrl.signal,
    });

    if (!res.ok || !res.body) {
      return {
        ok: false,
        status: res.status,
        elapsedMs: Math.round(performance.now() - start),
        resultBytes: 0,
        hostInputTokens: 0,
        hostOutputTokens: 0,
        hostReasoningTokens: 0,
        imageInputTokens: 0,
        imageOutputTokens: 0,
        error: `HTTP ${res.status}`,
      };
    }

    let resultBytes = 0;
    let hostInputTokens = 0;
    let hostOutputTokens = 0;
    let hostReasoningTokens = 0;
    let imageInputTokens = 0;
    let imageOutputTokens = 0;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let event = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line === "") { event = ""; continue; }
        if (line.startsWith("event: ")) {
          event = line.slice(7).trim();
        } else if (line.startsWith("data: ") && event) {
          let data: Record<string, unknown> | null = null;
          try { data = JSON.parse(line.slice(6)) as Record<string, unknown>; } catch { continue; }
          if (event === "response.output_item.done") {
            const item = data.item as Record<string, unknown> | undefined;
            if (item && item.type === "image_generation_call" && typeof item.result === "string") {
              resultBytes = item.result.length;
            }
          }
          if (event === "response.completed") {
            const resp = data.response as Record<string, unknown> | undefined;
            const u = resp?.usage as Record<string, unknown> | undefined;
            if (u) {
              if (typeof u.input_tokens === "number") hostInputTokens = u.input_tokens;
              if (typeof u.output_tokens === "number") hostOutputTokens = u.output_tokens;
              const out = u.output_tokens_details as Record<string, unknown> | undefined;
              if (out && typeof out.reasoning_tokens === "number") hostReasoningTokens = out.reasoning_tokens;
            }
            const tu = resp?.tool_usage as Record<string, unknown> | undefined;
            const img = tu?.image_gen as Record<string, unknown> | undefined;
            if (img) {
              if (typeof img.input_tokens === "number") imageInputTokens = img.input_tokens;
              if (typeof img.output_tokens === "number") imageOutputTokens = img.output_tokens;
            }
          }
        }
      }
    }

    return {
      ok: true,
      status: 200,
      elapsedMs: Math.round(performance.now() - start),
      resultBytes,
      hostInputTokens,
      hostOutputTokens,
      hostReasoningTokens,
      imageInputTokens,
      imageOutputTokens,
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      elapsedMs: Math.round(performance.now() - start),
      resultBytes: 0,
      hostInputTokens: 0,
      hostOutputTokens: 0,
      hostReasoningTokens: 0,
      imageInputTokens: 0,
      imageOutputTokens: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return Math.round(sorted[base] + rest * (sorted[base + 1] - sorted[base]));
  }
  return sorted[base];
}

interface ComboStats {
  model: string;
  size: string;
  ok: number;
  total: number;
  min: number;
  p50: number;
  p95: number;
  max: number;
  avgImageIn: number;
  avgImageOut: number;
  avgHostIn: number;
  avgHostOut: number;
  avgHostReasoning: number;
  avgBytes: number;
}

function summarize(model: string, size: string, runs: RunResult[]): ComboStats {
  const oks = runs.filter((r) => r.ok);
  const lats = oks.map((r) => r.elapsedMs).sort((a, b) => a - b);
  const avg = (xs: number[]) => xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : 0;
  return {
    model,
    size,
    ok: oks.length,
    total: runs.length,
    min: lats[0] ?? 0,
    p50: quantile(lats, 0.5),
    p95: quantile(lats, 0.95),
    max: lats[lats.length - 1] ?? 0,
    avgImageIn: avg(oks.map((r) => r.imageInputTokens)),
    avgImageOut: avg(oks.map((r) => r.imageOutputTokens)),
    avgHostIn: avg(oks.map((r) => r.hostInputTokens)),
    avgHostOut: avg(oks.map((r) => r.hostOutputTokens)),
    avgHostReasoning: avg(oks.map((r) => r.hostReasoningTokens)),
    avgBytes: avg(oks.map((r) => r.resultBytes)),
  };
}

async function main(): Promise<void> {
  console.log(`# Image-gen bench — ${CONCURRENCY} concurrent × ${ROUNDS} rounds per combo`);
  console.log(`# proxy: ${BASE_URL}`);
  console.log("");

  const allStats: ComboStats[] = [];

  for (const model of MODELS) {
    for (const size of SIZES) {
      console.log(`▶ ${model} × ${size} ...`);
      const runs: RunResult[] = [];
      for (let round = 0; round < ROUNDS; round++) {
        const batch = await Promise.allSettled(
          Array.from({ length: CONCURRENCY }, () => generate(model, size)),
        );
        for (const r of batch) {
          if (r.status === "fulfilled") runs.push(r.value);
          else runs.push({
            ok: false, status: 0, elapsedMs: 0, resultBytes: 0,
            hostInputTokens: 0, hostOutputTokens: 0, hostReasoningTokens: 0,
            imageInputTokens: 0, imageOutputTokens: 0,
            error: String(r.reason),
          });
        }
      }
      const stats = summarize(model, size, runs);
      allStats.push(stats);
      const failed = runs.filter((r) => !r.ok);
      if (failed.length > 0) {
        console.log(`  ⚠ ${failed.length}/${runs.length} failed: ${failed.map((f) => f.error).filter(Boolean).slice(0, 3).join(" | ")}`);
      } else {
        console.log(`  ✓ ${runs.length} ok | ${stats.min}/${stats.p50}/${stats.p95}/${stats.max} ms (min/p50/p95/max)`);
      }
    }
  }

  console.log("");
  console.log("## Latency");
  console.log("| model | size | ok | min | p50 | p95 | max | avg bytes |");
  console.log("|---|---|---|---:|---:|---:|---:|---:|");
  for (const s of allStats) {
    console.log(`| ${s.model} | ${s.size} | ${s.ok}/${s.total} | ${s.min} | ${s.p50} | ${s.p95} | ${s.max} | ${(s.avgBytes / 1_000_000).toFixed(2)} MB |`);
  }

  console.log("");
  console.log("## Tokens (avg)");
  console.log("| model | size | image in | image out | host in | host out | host reasoning |");
  console.log("|---|---|---:|---:|---:|---:|---:|");
  for (const s of allStats) {
    console.log(`| ${s.model} | ${s.size} | ${s.avgImageIn} | ${s.avgImageOut} | ${s.avgHostIn} | ${s.avgHostOut} | ${s.avgHostReasoning} |`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
