import type { UsageInfo } from "../../translation/codex-event-extractor.js";

export interface LogNonStreamingUsageOptions {
  tag: string;
  entryId: string;
  requestId: string;
  usage: UsageInfo;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

export function logNonStreamingUsage(options: LogNonStreamingUsageOptions): void {
  const { tag, entryId, requestId, usage, log = console.log, warn = console.warn } = options;
  const uncached = usage.cached_tokens ? usage.input_tokens - usage.cached_tokens : usage.input_tokens;
  const hitPct = usage.input_tokens > 0
    ? `${((usage.cached_tokens ?? 0) / usage.input_tokens * 100).toFixed(1)}%`
    : "n/a";

  log(
    `[${tag}] Account ${entryId} | rid=${requestId.slice(0, 8)} | Usage: in=${usage.input_tokens}` +
    (usage.cached_tokens ? ` (cached=${usage.cached_tokens} uncached=${uncached})` : "") +
    ` out=${usage.output_tokens}` +
    (usage.reasoning_tokens ? ` reasoning=${usage.reasoning_tokens}` : "") +
    ` | hit=${hitPct}`,
  );

  if (usage.input_tokens > 10_000) {
    warn(`[${tag}] ⚠ High input token count: ${usage.input_tokens} tokens`);
  }
}
