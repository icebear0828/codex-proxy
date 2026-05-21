import type { CodexApiError } from "../../proxy/codex-api.js";
import { stripCodexErrorPrefix } from "./proxy-handler-utils.js";

export interface RethrowNonStreamingCodexApiErrorDuringCollectOptions {
  err: CodexApiError;
  tag: string;
  entryId: string;
}

export function rethrowNonStreamingCodexApiErrorDuringCollect(
  options: RethrowNonStreamingCodexApiErrorDuringCollectOptions,
): never {
  const { err, tag, entryId } = options;

  console.warn(
    `[${tag}] Account ${entryId} | upstream ${err.status} during collect: ${stripCodexErrorPrefix(err.message).slice(0, 200)}`,
  );
  throw err;
}
