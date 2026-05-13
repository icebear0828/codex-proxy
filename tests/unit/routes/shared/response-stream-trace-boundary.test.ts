import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as streamTrace from "@src/routes/shared/response-stream-trace.js";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const RESPONSE_PROCESSOR_MODULE = "src/routes/shared/response-processor.ts";

function source(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf-8");
}

describe("response stream trace boundary", () => {
  it("exports stream trace helpers from their own module", () => {
    expect(streamTrace.createWrittenStreamTrace).toBeTypeOf("function");
    expect(streamTrace.inspectStreamChunk).toBeTypeOf("function");
    expect(streamTrace.applyWrittenChunkTrace).toBeTypeOf("function");
    expect(streamTrace.formatDiagnosticValue).toBeTypeOf("function");
    expect(streamTrace.streamErrorStatus).toBeTypeOf("function");
  });

  it("keeps stream tracing helpers out of the response processor", () => {
    const responseProcessor = source(RESPONSE_PROCESSOR_MODULE);

    expect(responseProcessor).toContain('from "./response-stream-trace.js"');
    expect(responseProcessor).not.toContain("function inspectStreamChunk");
    expect(responseProcessor).not.toContain("function isTerminalStreamEvent");
    expect(responseProcessor).not.toContain("function streamErrorStatus");
  });
});
