import { CodexApiError } from "../../proxy/codex-types.js";

export interface WrittenStreamTrace {
  chunks: number;
  bytes: number;
  lastEvent: string | null;
  sawTerminal: boolean;
}

export interface ChunkTrace {
  bytes: number;
  lastEvent: string | null;
  terminal: boolean;
}

function isTerminalStreamEvent(event: string): boolean {
  return event === "response.completed" ||
    event === "response.failed" ||
    event === "error" ||
    event === "message_stop" ||
    event === "[DONE]";
}

export function createWrittenStreamTrace(): WrittenStreamTrace {
  return {
    chunks: 0,
    bytes: 0,
    lastEvent: null,
    sawTerminal: false,
  };
}

export function inspectStreamChunk(chunk: string): ChunkTrace {
  const trace: ChunkTrace = {
    bytes: Buffer.byteLength(chunk, "utf8"),
    lastEvent: null,
    terminal: false,
  };

  for (const line of chunk.split(/\r?\n/)) {
    if (line.startsWith("event: ")) {
      const event = line.slice("event: ".length).trim();
      if (event) {
        trace.lastEvent = event;
        if (isTerminalStreamEvent(event)) trace.terminal = true;
      }
      continue;
    }
    if (line.startsWith("data: ")) {
      const data = line.slice("data: ".length).trim();
      if (data === "[DONE]") {
        trace.lastEvent = "[DONE]";
        trace.terminal = true;
      }
    }
  }

  return trace;
}

export function applyWrittenChunkTrace(written: WrittenStreamTrace, chunk: ChunkTrace): void {
  written.chunks += 1;
  written.bytes += chunk.bytes;
  if (chunk.lastEvent) written.lastEvent = chunk.lastEvent;
  if (chunk.terminal) written.sawTerminal = true;
}

export function formatDiagnosticValue(value: string | null | undefined): string {
  return value && value.length > 0 ? value : "none";
}

export function streamErrorStatus(err: unknown): number {
  if (err instanceof CodexApiError && err.status >= 400 && err.status < 600) {
    return err.status;
  }
  return 502;
}
