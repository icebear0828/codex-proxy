import { describe, expect, it } from "vitest";
import { OpenAIUpstream } from "@src/proxy/openai-upstream.js";

describe("OpenAIUpstream tool stream", () => {
  it("keeps function and custom tool call kinds through normalized events", async () => {
    const chunks = [
      { id: "chat_1", choices: [{ delta: { tool_calls: [
        { index: 0, id: "call_fn", type: "function", function: { name: "lookup", arguments: "{\"q\":" } },
        { index: 1, id: "call_custom", custom: { name: "shell", input: "echo " } },
      ] } }] },
      { id: "chat_1", choices: [{ delta: { tool_calls: [
        { index: 0, function: { arguments: "\"x\"}" } },
        { index: 1, custom: { input: "hello" } },
      ] } }] },
      { id: "chat_1", choices: [{ finish_reason: "tool_calls" }] },
    ];
    const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
    const events = [];
    for await (const event of new OpenAIUpstream("test", "unused").parseStream(new Response(body))) {
      events.push(event);
    }

    expect(events.filter((event) => event.event === "response.output_item.added").map((event) => event.data)).toEqual([
      { output_index: 0, item: { type: "function_call", id: "item_0", call_id: "call_fn", name: "lookup" } },
      { output_index: 1, item: { type: "custom_tool_call", id: "item_1", call_id: "call_custom", name: "shell" } },
    ]);
    expect(events.find((event) => event.event === "response.function_call_arguments.done")?.data).toMatchObject({
      call_id: "call_fn", arguments: '{"q":"x"}',
    });
    expect(events.find((event) => event.event === "response.custom_tool_call_input.done")?.data).toMatchObject({
      call_id: "call_custom", input: "echo hello",
    });
  });
});
