/**
 * Real upstream image_generation stress tests.
 *
 * Matrix:
 *   models: gpt-5.4-mini, gpt-5.5
 *   sizes:  1024x1024, 3840x2160 (4K UHD)
 *   each combo: 2 concurrent × 2 rounds = 4 images
 *   total: 16 images
 *
 * Verifies (per request):
 *   - HTTP 200 + completes
 *   - SSE contains response.image_generation_call.* lifecycle events
 *   - response.output_item.done carries a non-empty base64 `result`
 *   - response.completed carries tool_usage.image_gen.{input,output}_tokens > 0
 *
 * Verifies (across run): /admin/usage-stats/summary's
 *   total_image_output_tokens increment is positive.
 *
 * Premise: the active account is ChatGPT Plus or higher — Free accounts get
 * the image_generation tool silently stripped upstream and the model falls
 * back to SVG text.
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  PROXY_URL, TIMEOUT,
  checkProxy, skip, headers,
} from "./_helpers.js";

beforeAll(async () => {
  await checkProxy();
});

const SIZES = ["1024x1024", "3840x2160"] as const;
const MODELS = ["gpt-5.4-mini", "gpt-5.5"] as const;
const ROUNDS = 2;
const CONCURRENCY = 2;

// 4K renders typically 25–60s; 1024 is 12–25s. Allow generous headroom for
// concurrent contention.
const PER_REQUEST_TIMEOUT_MS = 180_000;
const COMBO_TIMEOUT_MS = 480_000;

interface ImageRequestResult {
  status: number;
  events: Set<string>;
  resultBase64Length: number;
  /** First few decoded bytes of the result. Used to detect SVG-text fallbacks
   *  that Free-tier accounts get when the image_generation tool is silently
   *  stripped upstream — those come back as `<svg ...>` text, not PNG/JPEG/WebP. */
  resultPrefix: string;
  imageInputTokens: number;
  imageOutputTokens: number;
  hostInputTokens: number;
  hostOutputTokens: number;
  elapsedMs: number;
  errorPayload?: unknown;
}

async function generateImage(model: string, size: string): Promise<ImageRequestResult> {
  const start = Date.now();
  const res = await fetch(`${PROXY_URL}/v1/responses`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      model,
      stream: true,
      input: [{ role: "user", content: "Draw a red circle on a white background." }],
      tools: [{ type: "image_generation", size }],
    }),
    signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS),
  });

  if (!res.ok || !res.body) {
    let errorPayload: unknown;
    try { errorPayload = await res.json(); } catch { errorPayload = await res.text(); }
    return {
      status: res.status,
      events: new Set(),
      resultBase64Length: 0,
      resultPrefix: "",
      imageInputTokens: 0,
      imageOutputTokens: 0,
      hostInputTokens: 0,
      hostOutputTokens: 0,
      elapsedMs: Date.now() - start,
      errorPayload,
    };
  }

  const events = new Set<string>();
  let resultBase64Length = 0;
  let resultPrefix = "";
  let imageInputTokens = 0;
  let imageOutputTokens = 0;
  let hostInputTokens = 0;
  let hostOutputTokens = 0;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";

  const handleEvent = (eventName: string, dataStr: string): void => {
    if (!eventName) return;
    events.add(eventName);
    if (!dataStr) return;
    let payload: Record<string, unknown> | null = null;
    try { payload = JSON.parse(dataStr) as Record<string, unknown>; } catch { return; }
    if (!payload) return;

    if (eventName === "response.output_item.done") {
      const item = payload.item as Record<string, unknown> | undefined;
      if (item && item.type === "image_generation_call" && typeof item.result === "string") {
        resultBase64Length = item.result.length;
        // Decode the first ~12 bytes to inspect the file magic. PNG starts
        // with "\x89PNG", JPEG with "\xff\xd8\xff", WebP with "RIFF....WEBP".
        // Free-tier downgrades come back as base64 of literal "<svg ..." text.
        try {
          resultPrefix = Buffer.from(item.result.slice(0, 16), "base64").toString("binary").slice(0, 8);
        } catch { /* leave empty */ }
      }
    }
    if (eventName === "response.completed") {
      const resp = payload.response as Record<string, unknown> | undefined;
      if (resp && resp.usage && typeof resp.usage === "object") {
        const u = resp.usage as Record<string, unknown>;
        if (typeof u.input_tokens === "number") hostInputTokens = u.input_tokens;
        if (typeof u.output_tokens === "number") hostOutputTokens = u.output_tokens;
      }
      if (resp && resp.tool_usage && typeof resp.tool_usage === "object") {
        const tu = resp.tool_usage as Record<string, unknown>;
        const img = tu.image_gen as Record<string, unknown> | undefined;
        if (img) {
          if (typeof img.input_tokens === "number") imageInputTokens = img.input_tokens;
          if (typeof img.output_tokens === "number") imageOutputTokens = img.output_tokens;
        }
      }
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nlIdx;
    while ((nlIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nlIdx);
      buffer = buffer.slice(nlIdx + 1);
      if (line === "") {
        currentEvent = "";
        continue;
      }
      if (line.startsWith("event: ")) {
        currentEvent = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        handleEvent(currentEvent, line.slice(6));
      }
    }
  }

  return {
    status: res.status,
    events,
    resultBase64Length,
    resultPrefix,
    imageInputTokens,
    imageOutputTokens,
    hostInputTokens,
    hostOutputTokens,
    elapsedMs: Date.now() - start,
  };
}

/** Returns true when the first decoded bytes match a real raster image
 *  (PNG / JPEG / WebP) rather than a plain-text fallback (e.g. SVG). */
function isRealImage(prefix: string): boolean {
  if (prefix.startsWith("\x89PNG")) return true;
  if (prefix.startsWith("\xff\xd8\xff")) return true; // JPEG SOI
  if (prefix.startsWith("RIFF")) return true; // WebP / other RIFF
  if (prefix.startsWith("GIF8")) return true;
  return false;
}

interface UsageSummary {
  total_image_input_tokens: number;
  total_image_output_tokens: number;
  total_image_request_count: number;
  total_image_request_failed_count: number;
  total_request_count: number;
  [key: string]: unknown;
}

async function fetchSummary(): Promise<UsageSummary> {
  const res = await fetch(`${PROXY_URL}/admin/usage-stats/summary`, {
    headers: headers(),
    signal: AbortSignal.timeout(10_000),
  });
  return await res.json() as UsageSummary;
}

describe("real: image_generation matrix", () => {
  for (const model of MODELS) {
    for (const size of SIZES) {
      // Lower bound is intentionally generous — a flat-color PNG can compress
      // surprisingly well. The hard correctness check is the file-magic test
      // (isRealImage) which rejects SVG-text fallbacks regardless of size.
      const minBytes = size === "1024x1024" ? 50_000 : 500_000;

      it(`${model} × ${size}: ${CONCURRENCY} concurrent × ${ROUNDS} rounds all produce non-empty images`, async () => {
        if (skip()) return;

        const all: ImageRequestResult[] = [];
        for (let round = 0; round < ROUNDS; round++) {
          const batch = await Promise.all(
            Array.from({ length: CONCURRENCY }, () => generateImage(model, size)),
          );
          all.push(...batch);
        }

        const failures = all.filter((r) => r.status !== 200);
        if (failures.length > 0) {
          console.warn(`[image-gen] ${model} × ${size}: ${failures.length}/${all.length} failed:`, failures.map((f) => f.errorPayload));
        }

        for (const r of all) {
          expect(r.status, "HTTP status").toBe(200);
          expect(r.events.has("response.completed"), "saw response.completed").toBe(true);
          expect(r.events.has("response.image_generation_call.generating"), "saw image_generation_call.generating").toBe(true);
          expect(r.events.has("response.output_item.done"), "saw output_item.done").toBe(true);
          // The hard check: file magic must match PNG / JPEG / WebP / GIF, not SVG text.
          // Free accounts get the image_generation tool silently stripped and the model
          // returns base64-of-SVG-text, which would otherwise pass the size threshold.
          expect(isRealImage(r.resultPrefix), `result is a real raster image (got prefix ${JSON.stringify(r.resultPrefix)})`).toBe(true);
          expect(r.resultBase64Length, "image result base64 length").toBeGreaterThan(minBytes);
          expect(r.imageOutputTokens, "tool_usage.image_gen.output_tokens > 0").toBeGreaterThan(0);
        }

        const totalElapsed = all.reduce((s, r) => s + r.elapsedMs, 0);
        console.log(
          `[image-gen] ${model} × ${size}: ${all.length} ok | ` +
          `latency min/avg/max = ${Math.min(...all.map((r) => r.elapsedMs))}/` +
          `${Math.round(totalElapsed / all.length)}/` +
          `${Math.max(...all.map((r) => r.elapsedMs))} ms | ` +
          `image_tokens avg in/out = ${Math.round(all.reduce((s, r) => s + r.imageInputTokens, 0) / all.length)}/` +
          `${Math.round(all.reduce((s, r) => s + r.imageOutputTokens, 0) / all.length)}`,
        );
      }, COMBO_TIMEOUT_MS);
    }
  }

  it("end-to-end: total_image_output_tokens + image_request_count increased after the matrix run", async () => {
    if (skip()) return;
    // Light single shot to ensure at least one summary delta even if other tests were skipped
    // (real-world: snapshot recording is on a timer, so summary is computed live from pool entries
    //  + baseline — should reflect immediately).
    const before = await fetchSummary();
    const r = await generateImage("gpt-5.4-mini", "1024x1024");
    expect(r.status).toBe(200);
    expect(isRealImage(r.resultPrefix), "result is a real raster image (account is Plus+)").toBe(true);
    expect(r.imageOutputTokens).toBeGreaterThan(0);

    // Allow up to 2 polls — release happens in a finally{} after the SSE stream closes.
    let after = await fetchSummary();
    if (after.total_image_output_tokens === before.total_image_output_tokens) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      after = await fetchSummary();
    }
    expect(after.total_image_output_tokens).toBeGreaterThan(before.total_image_output_tokens);
    expect(after.total_image_input_tokens).toBeGreaterThanOrEqual(before.total_image_input_tokens);
    expect(typeof after.total_image_input_tokens).toBe("number");

    // Counter should tick by exactly 1 (this single successful image gen).
    // Failed counter should not move on a successful Plus+ call.
    expect(after.total_image_request_count - before.total_image_request_count).toBe(1);
    expect(after.total_image_request_failed_count).toBe(before.total_image_request_failed_count);
  }, TIMEOUT * 4);
});
