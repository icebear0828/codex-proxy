import { describe, expect, it } from "vitest";
import { GeminiUpstream } from "@src/proxy/gemini-upstream.js";
import { translateCodexToGeminiRequest } from "@src/translation/codex-request-to-gemini.js";
import { streamCodexToAnthropic } from "@src/translation/codex-to-anthropic.js";
import type { CodexResponsesRequest } from "@src/proxy/codex-types.js";

function geminiResponse(chunks: unknown[]): Response {
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(""), {
    headers: { "Content-Type": "text/event-stream" },
  });
}

async function messages(upstream: GeminiUpstream, chunks: unknown[]): Promise<Array<Record<string, unknown>>> {
  const events: Array<Record<string, unknown>> = [];
  for await (const chunk of streamCodexToAnthropic(upstream, geminiResponse(chunks), "gemini-3.8-flash-medium")) {
    const data = chunk.split("\n").find((line) => line.startsWith("data: "));
    if (data) events.push(JSON.parse(data.slice(6)) as Record<string, unknown>);
  }
  return events;
}

describe("Anthropic Messages and Gemini tool round trip", () => {
  it("keeps schema, call ID, signature, result name, and final text across two turns", async () => {
    const upstream = new GeminiUpstream("fake-key");
    const first: CodexResponsesRequest = {
      model: "gemini-3.8-flash-medium", stream: true, store: false,
      input: [{ role: "developer", content: "Follow instructions" }, { role: "user", content: "Read a file" }],
      tools: [{ type: "function", name: "Read", parameters: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object", properties: {
          path: { type: "string", const: "README.md" },
          options: { anyOf: [{ type: "object", properties: {
            mode: { type: "string", propertyNames: { pattern: ".*" } },
          } }, { type: "null" }] },
        }, required: ["path"],
      } }],
    };
    const request = translateCodexToGeminiRequest(first);
    const schema = request.tools?.[0].functionDeclarations[0].parameters;
    expect(JSON.stringify(schema)).not.toMatch(/\$schema|propertyNames|"const"/);
    expect(request.system_instruction?.parts).toEqual([{ text: "Follow instructions" }]);

    const firstEvents = await messages(upstream, [
      { candidates: [{ content: { parts: [{ functionCall: {
        id: "native-call", name: "Read", args: { path: "README.md" },
      }, thoughtSignature: "signed-thought" }] } }] },
      { candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 24, candidatesTokenCount: 5 } },
    ]);
    const toolStart = firstEvents.find((event) => event.type === "content_block_start" &&
      (event.content_block as Record<string, unknown> | undefined)?.type === "tool_use");
    expect(toolStart?.content_block).toMatchObject({
      id: "native-call", name: "Read", signature: "signed-thought",
    });
    expect(firstEvents.find((event) => event.type === "message_delta")?.delta).toMatchObject({
      stop_reason: "tool_use",
    });

    const second = translateCodexToGeminiRequest({
      ...first, input: [
        ...first.input,
        { type: "function_call", call_id: "native-call", name: "Read", arguments: '{"path":"README.md"}', signature: "signed-thought" },
        { type: "function_call_output", call_id: "native-call", output: "file contents" },
      ],
    });
    expect(second.contents.at(-1)).toEqual({ role: "user", parts: [{ functionResponse: {
      name: "Read", id: "native-call", response: { output: "file contents" },
    } }] });
    const finalEvents = await messages(upstream, [
      { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "Done" }] } }],
        usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 2 } },
    ]);
    expect(finalEvents.find((event) => event.type === "content_block_delta")?.delta).toEqual({
      type: "text_delta", text: "Done",
    });
    expect(finalEvents.at(-1)?.type).toBe("message_stop");
  });
});
