import { calculateUsageCostUsd, loadPricingCatalog, type PricingCatalog, type UsageCostInput } from "../auth/usage-pricing.js";
import type { UsageInfo } from "../translation/codex-event-extractor.js";

export interface LogMetrics {
  ttftMs?: number | null;
  durationMs?: number | null;
  costUsd?: number | null;
  tokensPerSecond?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedTokens?: number | null;
  reasoningTokens?: number | null;
  totalTokens?: number | null;
}

export interface CalculateLogMetricsOptions {
  startMs: number;
  firstTokenMs?: number | null;
  endMs?: number;
  model?: string | null;
  usage?: UsageInfo | UsageCostInput | null;
  pricingCatalog?: PricingCatalog;
  nowMs?: () => number;
  isStreaming?: boolean;
}

let cachedCatalog: PricingCatalog | null = null;

function getCatalog(): PricingCatalog {
  if (!cachedCatalog) {
    try {
      cachedCatalog = loadPricingCatalog();
    } catch {
      cachedCatalog = {};
    }
  }
  return cachedCatalog;
}

export function resetPricingCatalogCache(): void {
  cachedCatalog = null;
}

export function calculateLogMetrics(options: CalculateLogMetricsOptions): LogMetrics {
  const {
    startMs,
    firstTokenMs,
    endMs = Date.now(),
    model,
    usage,
    pricingCatalog = getCatalog(),
    isStreaming = firstTokenMs !== undefined,
  } = options;

  const durationMs = Math.max(0, Math.round(endMs - startMs));
  let ttftMs: number | null = null;
  if (firstTokenMs != null && Number.isFinite(firstTokenMs)) {
    ttftMs = Math.max(0, Math.round(firstTokenMs - startMs));
  } else if (!isStreaming && durationMs > 0 && firstTokenMs === undefined) {
    ttftMs = durationMs;
  }

  let costUsd: number | null = null;
  let tokensPerSecond: number | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let cachedTokens: number | null = null;
  let reasoningTokens: number | null = null;
  let totalTokens: number | null = null;

  if (usage) {
    inputTokens = usage.input_tokens ?? 0;
    outputTokens = usage.output_tokens ?? 0;
    cachedTokens = usage.cached_tokens ?? 0;
    if ("reasoning_tokens" in usage) {
      reasoningTokens = usage.reasoning_tokens ?? 0;
    }
    totalTokens = inputTokens + outputTokens;

    if (model) {
      costUsd = calculateUsageCostUsd(model, usage, pricingCatalog);
      // Round to 6 decimal places for precision without floating point noise
      costUsd = Math.round(costUsd * 1_000_000) / 1_000_000;
    }

    if (outputTokens > 0) {
      // If streaming and we know when the first token arrived, calculate generation speed based on generation duration.
      // If generation duration is very small (< 20ms), fallback to total duration to avoid division by zero or inflated spikes.
      if (firstTokenMs != null && endMs - firstTokenMs >= 20) {
        const generationSec = (endMs - firstTokenMs) / 1000;
        tokensPerSecond = Math.round((outputTokens / generationSec) * 10) / 10;
      } else if (durationMs > 0) {
        const durationSec = durationMs / 1000;
        tokensPerSecond = Math.round((outputTokens / durationSec) * 10) / 10;
      }
    } else {
      tokensPerSecond = 0;
    }
  }

  return {
    ttftMs,
    durationMs,
    costUsd,
    tokensPerSecond,
    inputTokens,
    outputTokens,
    cachedTokens,
    reasoningTokens,
    totalTokens,
  };
}
