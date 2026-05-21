import { CodexApiError } from "@src/proxy/codex-api.js";
import {
  applyWrittenChunkTrace,
  createWrittenStreamTrace,
  formatDiagnosticValue,
  inspectStreamChunk,
  streamErrorStatus,
} from "@src/routes/shared/response-stream-trace.js";
import { describe, expect, it } from "vitest";

describe("response stream trace helpers", () => {
  it("detects terminal event lines and counts UTF-8 bytes", () => {
    const trace = inspectStreamChunk("event: response.completed\ndata: {}\n\n");

    expect(trace).toEqual({
      bytes: Buffer.byteLength("event: response.completed\ndata: {}\n\n", "utf8"),
      lastEvent: "response.completed",
      terminal: true,
    });
  });

  it("detects OpenAI-style [DONE] data frames as terminal", () => {
    expect(inspectStreamChunk("data: [DONE]\n\n")).toEqual({
      bytes: Buffer.byteLength("data: [DONE]\n\n", "utf8"),
      lastEvent: "[DONE]",
      terminal: true,
    });
  });

  it("applies chunk traces to the aggregate written stream trace", () => {
    const written = createWrittenStreamTrace();

    applyWrittenChunkTrace(written, inspectStreamChunk("event: response.created\ndata: {}\n\n"));
    applyWrittenChunkTrace(written, inspectStreamChunk("event: response.completed\ndata: {}\n\n"));

    expect(written).toEqual({
      chunks: 2,
      bytes:
        Buffer.byteLength("event: response.created\ndata: {}\n\n", "utf8") +
        Buffer.byteLength("event: response.completed\ndata: {}\n\n", "utf8"),
      lastEvent: "response.completed",
      sawTerminal: true,
    });
  });

  it("formats missing diagnostic values consistently", () => {
    expect(formatDiagnosticValue(undefined)).toBe("none");
    expect(formatDiagnosticValue(null)).toBe("none");
    expect(formatDiagnosticValue("")).toBe("none");
    expect(formatDiagnosticValue("rid-123")).toBe("rid-123");
  });

  it("maps stream errors to client-facing status codes", () => {
    expect(streamErrorStatus(new CodexApiError(429, '{"error":{"message":"rate limited"}}'))).toBe(429);
    expect(streamErrorStatus(new CodexApiError(0, '{"error":{"message":"transport"}}'))).toBe(502);
    expect(streamErrorStatus(new Error("stream died"))).toBe(502);
  });
});
