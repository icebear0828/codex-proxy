import type { UsageInfo } from "../../translation/codex-event-extractor.js";

export interface LogProxyUsageOptions {
  tag: string;
  entryId: string;
  requestId: string;
  usage: UsageInfo;
  includeImageTokens?: boolean;
  includeReasoningInHighInputWarning?: boolean;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

export function logProxyUsage(options: LogProxyUsageOptions): void {
  const {
    tag,
    entryId,
    requestId,
    usage,
    includeImageTokens = false,
    includeReasoningInHighInputWarning = false,
    log = console.log,
    warn = console.warn,
  } = options;
  const uncached = usage.cached_tokens ? usage.input_tokens - usage.cached_tokens : usage.input_tokens;
  const hitPct = usage.input_tokens > 0
    ? `${((usage.cached_tokens ?? 0) / usage.input_tokens * 100).toFixed(1)}%`
    : "n/a";
  const imgIn = usage.image_input_tokens ?? 0;
  const imgOut = usage.image_output_tokens ?? 0;

  log(
    `[${tag}] Account ${entryId} | rid=${requestId.slice(0, 8)} | Usage: in=${usage.input_tokens}` +
    (usage.cached_tokens ? ` (cached=${usage.cached_tokens} uncached=${uncached})` : "") +
    ` out=${usage.output_tokens}` +
    (usage.reasoning_tokens ? ` reasoning=${usage.reasoning_tokens}` : "") +
    (includeImageTokens && (imgIn || imgOut) ? ` image=${imgIn}/${imgOut}` : "") +
    ` | hit=${hitPct}`,
  );

  if (usage.input_tokens > 10_000) {
    warn(
      `[${tag}] ⚠ High input token count: ${usage.input_tokens} tokens` +
      (includeReasoningInHighInputWarning && usage.reasoning_tokens ? ` (reasoning=${usage.reasoning_tokens})` : ""),
    );
  }
}
