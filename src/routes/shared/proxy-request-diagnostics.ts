import type { ProxyRequest } from "./proxy-handler-types.js";

export interface BuildRequestDiagnosticsOptions {
  tag: string;
  entryId: string;
  requestId: string;
  request: ProxyRequest;
  chainConversationId: string | null | undefined;
  promptCacheKey: string;
  variantHash: string;
  explicitPrevRespId: string | undefined;
  implicitPrevRespId: string | null;
  prevRespId: string | null | undefined;
  resumeActive: boolean;
  resumeReason?: string | null;
  preferredEntryId: string | null;
}

export interface RequestDiagnostics {
  summary: string;
  payloadBytes: number;
  largePayloadWarning?: string;
}

function itemRole(item: unknown): unknown {
  if (typeof item !== "object" || item === null) {
    return undefined;
  }
  const record = item as Record<string, unknown>;
  return "role" in record ? record.role : record.type;
}

export function buildRequestDiagnostics(options: BuildRequestDiagnosticsOptions): RequestDiagnostics {
  const codexRequest = options.request.codexRequest;
  const reqJson = JSON.stringify(codexRequest);
  const inputItems = codexRequest.input?.length ?? 0;
  const instrLen = codexRequest.instructions?.length ?? 0;
  const toolsCount = codexRequest.tools?.length ?? 0;
  const affinityHit = options.preferredEntryId && options.entryId === options.preferredEntryId;
  const reasoningField = codexRequest.reasoning
    ? `effort=${codexRequest.reasoning.effort ?? "none"} summary=${codexRequest.reasoning.summary ?? "none"}`
    : "off";
  const prevSrc = options.explicitPrevRespId
    ? "explicit"
    : options.implicitPrevRespId
      ? "implicit"
      : null;
  const prevField = prevSrc && options.prevRespId
    ? `${prevSrc}:${options.prevRespId.slice(-8)}`
    : "none";
  const convField = options.chainConversationId ? options.chainConversationId.slice(0, 8) : "none";
  const keyField = options.promptCacheKey.slice(0, 8);
  const resumeField = options.explicitPrevRespId
    ? "explicit"
    : options.implicitPrevRespId
      ? (options.resumeActive ? "on" : `off:${options.resumeReason}`)
      : null;

  const summary =
    `[${options.tag}] Account ${options.entryId} | model=${options.request.model} | rid=${options.requestId.slice(0, 8)} conv=${convField} key=${keyField} vh=${options.variantHash} prev=${prevField}` +
    (resumeField ? ` resume=${resumeField}` : "") +
    ` | input_items=${inputItems} tools=${toolsCount} instr=${instrLen}B payload=${reqJson.length}B reasoning=[${reasoningField}]` +
    (options.prevRespId ? ` | affinity=${affinityHit ? "hit" : "miss"}` : "");

  if (reqJson.length <= 50_000) {
    return { summary, payloadBytes: reqJson.length };
  }

  const itemSizes = (codexRequest.input ?? []).map((item, i) => {
    const sz = JSON.stringify(item).length;
    return `  [${i}] ${itemRole(item)} ${sz}B`;
  });
  return {
    summary,
    payloadBytes: reqJson.length,
    largePayloadWarning:
      `[${options.tag}] ⚠ Large payload (${(reqJson.length / 1024).toFixed(1)}KB) — input_items=${inputItems} instr=${instrLen}B\n` +
      `  instructions: ${instrLen}B\n` +
      itemSizes.join("\n"),
  };
}
