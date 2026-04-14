import { describe, it, expect } from "vitest";
import { parseSSEBlock, parseSSEStream } from "@src/proxy/codex-sse.js";

describe("parseSSEBlock", () => {
  it("parses event + data", () => {
    const block = "event: response.created\ndata: {\"id\":\"resp_1\"}";
    const result = parseSSEBlock(block);
    expect(result).toEqual({
      event: "response.created",
      data: { id: "resp_1" },
    });
  });

  it("returns null for empty block", () => {
    expect(parseSSEBlock("")).toBeNull();
    expect(parseSSEBlock("   ")).toBeNull();
  });

  it("returns null for [DONE]", () => {
    const block = "data: [DONE]";
    expect(parseSSEBlock(block)).toBeNull();
  });

  it("handles data without event", () => {
    const block = 'data: {"type":"text"}';
    const result = parseSSEBlock(block);
    expect(result).toEqual({ event: "", data: { type: "text" } });
  });

  it("handles event without data", () => {
    const block = "event: done";
    const result = parseSSEBlock(block);
    expect(result).toEqual({ event: "done", data: "" });
  });

  it("joins multi-line data", () => {
    const block = "event: test\ndata: line1\ndata: line2";
    const result = parseSSEBlock(block);
    expect(result?.data).toBe("line1\nline2");
  });

  it("handles non-JSON data gracefully", () => {
    const block = "event: error\ndata: plain text error";
    const result = parseSSEBlock(block);
    expect(result?.data).toBe("plain text error");
  });
});

describe("parseSSEStream", () => {
  function makeResponse(text: string): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(text));
        controller.close();
      },
    });
    return new Response(stream);
  }

  it("yields events from SSE stream", async () => {
    const sse = "event: response.created\ndata: {\"id\":\"r1\"}\n\nevent: response.done\ndata: {\"id\":\"r1\"}\n\n";
    const events = [];
    for await (const evt of parseSSEStream(makeResponse(sse))) {
      events.push(evt);
    }
    expect(events).toHaveLength(2);
    expect(events[0].event).toBe("response.created");
    expect(events[1].event).toBe("response.done");
  });

  it("handles non-SSE response as error event", async () => {
    const json = '{"detail":"unauthorized"}';
    const events = [];
    for await (const evt of parseSSEStream(makeResponse(json))) {
      events.push(evt);
    }
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("error");
    const data = events[0].data as Record<string, Record<string, string>>;
    expect(data.error.message).toBe("unauthorized");
  });

  it("throws on null body", async () => {
    const response = new Response(null);
    const gen = parseSSEStream(response);
    await expect(gen.next()).rejects.toThrow("Response body is null");
  });
});
