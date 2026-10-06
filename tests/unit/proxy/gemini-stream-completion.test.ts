import { describe, expect, it } from "vitest";
import { GeminiUpstream } from "@src/proxy/gemini-upstream.js";
import type { CodexSSEEvent } from "@src/proxy/codex-types.js";

function makeResponse(text: string): Response {
  return new Response(text, { headers: { "Content-Type": "text/event-stream" } });
}

async function collect(gen: AsyncGenerator<CodexSSEEvent>): Promise<CodexSSEEvent[]> {
  const events: CodexSSEEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

describe("GeminiUpstream stream completion", () => {
  it("does not mark a cut-off stream completed", async () => {
    const upstream = new GeminiUpstream("fake-key");
    const response = makeResponse(`data: ${JSON.stringify({
      candidates: [{ content: { parts: [{ text: "partial answer" }] } }],
    })}\n\n`);

    await expect(collect(upstream.parseStream(response))).rejects.toThrow(
      "ended before the upstream reported a candidate finish reason",
    );
  });

  it("rejects a normally terminated stream with no user-visible output", async () => {
    const upstream = new GeminiUpstream("fake-key");
    const response = makeResponse(`data: ${JSON.stringify({
      candidates: [{ finishReason: "STOP", content: { parts: [] } }],
    })}\n\n`);

    await expect(collect(upstream.parseStream(response))).rejects.toThrow(
      "completed without producing text or a tool call",
    );
  });

  it("completes a stream that has output and a candidate finish reason", async () => {
    const upstream = new GeminiUpstream("fake-key");
    const response = makeResponse(`data: ${JSON.stringify({
      candidates: [{
        finishReason: "STOP",
        content: { parts: [{ text: "complete answer" }] },
      }],
    })}\n\n`);

    const events = await collect(upstream.parseStream(response));

    expect(events.some((event) => event.event === "response.output_text.delta")).toBe(true);
    expect(events.at(-1)?.event).toBe("response.completed");
  });
});
