import type { CodexResponsesRequest } from "../../proxy/codex-api.js";
import { debugDump, debugDumpEnabled } from "../../utils/debug-dump.js";

export interface DumpProxyRequestOptions {
  requestId: string;
  tag: string;
  entryId: string;
  conversationId: string | null | undefined;
  implicitResumeActive: boolean;
  resumeReason: string | null | undefined;
  payload: CodexResponsesRequest;
}

export function dumpProxyRequest(options: DumpProxyRequestOptions): void {
  if (!debugDumpEnabled()) return;
  debugDump("request", {
    rid: options.requestId,
    tag: options.tag,
    entryId: options.entryId,
    conv: options.conversationId ?? null,
    implicitResumeActive: options.implicitResumeActive,
    resumeReason: options.resumeReason,
    payload: options.payload,
  });
}
