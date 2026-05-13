import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { handleStreaming } from "@src/routes/shared/streaming-handler.js";

const ROOT = process.cwd();
const STREAMING_HANDLER_MODULE = "src/routes/shared/streaming-handler.ts";
const PROXY_HANDLER_MODULE = "src/routes/shared/proxy-handler.ts";

function source(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf-8");
}

describe("streaming handler module boundary", () => {
  it("exports the streaming response handler from its own module", () => {
    expect(handleStreaming).toBeTypeOf("function");
    const streamingHandler = source(STREAMING_HANDLER_MODULE);
    expect(streamingHandler).toContain("export function handleStreaming");
    expect(streamingHandler).toContain("streamResponse");
    expect(streamingHandler).toContain("recordStreamCloseEvent");
  });

  it("keeps streaming response details out of the runtime proxy handler", () => {
    const proxyHandler = source(PROXY_HANDLER_MODULE);
    expect(proxyHandler).toContain('from "./streaming-handler.js"');
    expect(proxyHandler).not.toContain("streamResponse({");
    expect(proxyHandler).not.toContain("recordStreamAffinity");
    expect(proxyHandler).not.toContain("recordStreamCloseEvent");
    expect(proxyHandler).not.toContain("releaseAccount(accountPool, capturedEntryId");
  });
});
