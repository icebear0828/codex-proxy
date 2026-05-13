import { CodexApi } from "../../proxy/codex-api.js";
import type { CookieJar } from "../../proxy/cookie-jar.js";
import type { ProxyPool } from "../../proxy/proxy-pool.js";
import type { UsageInfo } from "../../translation/codex-event-extractor.js";

/** Strip CodexApiError's "Codex API error (NNN): " prefix so log warns that
 *  already include status= don't duplicate it inside the message body. */
export function stripCodexErrorPrefix(msg: string): string {
  return msg.replace(/^Codex API error \(\d+\): /, "");
}

/** Annotate a usage payload with image_generation attempt outcome before
 *  releasing the account, so `recordUsage` can split it into success vs failed
 *  counters. Synthesizes a usage object when the failure path has none. */
export function annotateImageGenOutcome(
  usage: UsageInfo | undefined,
  expectsImageGen: boolean | undefined,
): UsageInfo | undefined {
  if (!expectsImageGen) return usage;
  const succeeded = (usage?.image_output_tokens ?? 0) > 0;
  if (usage) {
    return { ...usage, image_request_attempted: true, image_request_succeeded: succeeded };
  }
  return {
    input_tokens: 0,
    output_tokens: 0,
    image_request_attempted: true,
    image_request_succeeded: false,
  };
}

export function buildCodexApi(
  token: string,
  accountId: string | null,
  cookieJar: CookieJar | undefined,
  entryId: string,
  proxyPool?: ProxyPool,
): CodexApi {
  const proxyUrl = proxyPool?.resolveProxyUrl(entryId);
  return new CodexApi(token, accountId, cookieJar, entryId, proxyUrl);
}
