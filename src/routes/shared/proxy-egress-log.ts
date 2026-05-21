import { enqueueLogEntry } from "../../logs/entry.js";
import type { ProxyRequest } from "./proxy-handler-types.js";

export interface RecordProxyEgressLogOptions {
  requestId: string;
  request: ProxyRequest;
  status: number | null;
  startMs: number;
  error?: string;
  nowMs?: () => number;
}

export function recordProxyEgressLog(options: RecordProxyEgressLogOptions): void {
  const nowMs = options.nowMs ?? Date.now;
  enqueueLogEntry({
    requestId: options.requestId,
    direction: "egress",
    method: "POST",
    path: "/codex/responses",
    model: options.request.model,
    provider: "codex",
    status: options.status,
    latencyMs: nowMs() - options.startMs,
    stream: options.request.isStreaming,
    ...(options.error !== undefined ? { error: options.error } : {}),
    request: {
      model: options.request.codexRequest.model,
      stream: options.request.codexRequest.stream,
      useWebSocket: options.request.codexRequest.useWebSocket,
      ...(options.request.codexRequest.reasoning
        ? { reasoning: options.request.codexRequest.reasoning }
        : {}),
      ...(options.request.codexRequest.service_tier !== undefined && options.request.codexRequest.service_tier !== null
        ? { service_tier: options.request.codexRequest.service_tier }
        : {}),
    },
  });
}
