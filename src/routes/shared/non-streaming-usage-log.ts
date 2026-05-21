import type { UsageInfo } from "../../translation/codex-event-extractor.js";
import { logProxyUsage } from "./proxy-usage-log.js";

export interface LogNonStreamingUsageOptions {
  tag: string;
  entryId: string;
  requestId: string;
  usage: UsageInfo;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

export function logNonStreamingUsage(options: LogNonStreamingUsageOptions): void {
  logProxyUsage(options);
}
