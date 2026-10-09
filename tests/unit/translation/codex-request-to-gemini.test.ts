import { describe, expect, it } from "vitest";
import { translateCodexToGeminiRequest } from "@src/translation/codex-request-to-gemini.js";
import type { CodexResponsesRequest } from "@src/proxy/codex-types.js";

function request(input: CodexResponsesRequest["input"], tools?: unknown[]): CodexResponsesRequest {
  return { model: "gemini-test", stream: true, store: false, input, tools };
}

describe("Codex to Gemini tool translation", () => {
  it("filters unsupported schema keywords and resolves local references", () => {
    const body = translateCodexToGeminiRequest(request([{ role: "user", content: "hi" }], [{
      type: "function", name: "Read", parameters: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object", $defs: { path: { type: "string", const: "fixed", propertyNames: { pattern: ".*" } } },
        properties: { path: { $ref: "#/$defs/path" } }, required: ["path"],
      },
    }]));
    expect(body.tools?.[0].functionDeclarations[0]).toEqual({
      name: "Read", description: undefined,
      parameters: { type: "OBJECT", properties: { path: { type: "STRING", enum: ["fixed"] } }, required: ["path"] },
    });
  });

  it("flattens composed object schemas and nullable union types", () => {
    const body = translateCodexToGeminiRequest(request([{ role: "user", content: "hi" }], [{
      type: "function", name: "Edit", parameters: {
        allOf: [
          { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          { type: "object", properties: { note: { type: ["string", "null"] } } },
        ],
      },
    }]));
    expect(body.tools?.[0].functionDeclarations[0].parameters).toEqual({
      type: "OBJECT", properties: { path: { type: "STRING" }, note: { type: "STRING", nullable: true } }, required: ["path"],
    });
  });

  it("preserves tool call identity and matches its response", () => {
    const body = translateCodexToGeminiRequest(request([
      { type: "function_call", call_id: "call-1", name: "Read", arguments: "{\"path\":\"a\"}", signature: "sig" },
      { type: "function_call_output", call_id: "call-1", output: "ok" },
    ]));
    expect(body.contents).toEqual([
      { role: "model", parts: [{ functionCall: { name: "Read", id: "call-1", args: { path: "a" } }, thoughtSignature: "sig" }] },
      { role: "user", parts: [{ functionResponse: { name: "Read", id: "call-1", response: { output: "ok" } } }] },
    ]);
  });

  it("uses Gemini's documented validator bypass for calls without a returned signature", () => {
    const body = translateCodexToGeminiRequest(request([
      { type: "function_call", call_id: "call-2", name: "Read", arguments: "{}" },
      { type: "function_call_output", call_id: "call-2", output: "ok" },
    ]));
    expect(body.contents[0].parts[0]).toMatchObject({
      functionCall: { name: "Read", id: "call-2" },
      thoughtSignature: "skip_thought_signature_validator",
    });
  });

  it("maps forced tool selection and preserves image bytes", () => {
    const body = translateCodexToGeminiRequest({
      ...request([{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,YWJj" }] }]),
      tool_choice: { type: "function", name: "Read" },
    });
    expect(body.toolConfig).toEqual({ functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["Read"] } });
    expect(body.contents[0].parts[0]).toEqual({ inlineData: { mimeType: "image/png", data: "YWJj" } });
  });

  it("rejects malformed tool arguments and unmatched results", () => {
    expect(() => translateCodexToGeminiRequest(request([
      { type: "function_call", call_id: "a", name: "Read", arguments: "{" },
    ]))).toThrow("Invalid JSON arguments");
    expect(() => translateCodexToGeminiRequest(request([
      { type: "function_call_output", call_id: "a", output: "ok" },
    ]))).toThrow("no matching call");
  });

  it("keeps system and developer instructions out of user turns", () => {
    const body = translateCodexToGeminiRequest({
      ...request([
        { role: "system", content: "system instruction" },
        { role: "developer", content: [{ type: "input_text", text: "developer instruction" }] },
        { role: "user", content: "hello" },
      ]),
      instructions: "top-level instruction",
    });
    expect(body.system_instruction?.parts).toEqual([
      { text: "top-level instruction" },
      { text: "system instruction" },
      { text: "developer instruction" },
    ]);
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "hello" }] }]);
  });

  it("converts structured output schema before sending it to Gemini", () => {
    const body = translateCodexToGeminiRequest({
      ...request([{ role: "user", content: "hello" }]),
      text: { format: { type: "json_schema", schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object", properties: { answer: { type: "string", const: "ok" } },
      } } },
    });
    expect(body.generationConfig?.responseSchema).toEqual({
      type: "OBJECT", properties: { answer: { type: "STRING", enum: ["ok"] } },
    });
  });

  it("resolves escaped JSON pointers and bounds recursive references", () => {
    const body = translateCodexToGeminiRequest(request([{ role: "user", content: "hi" }], [{
      type: "function", name: "Read", parameters: {
        definitions: { "path/name": { type: "string" } },
        type: "object", properties: { path: { $ref: "#/definitions/path~1name" } },
      },
    }]));
    expect(body.tools?.[0].functionDeclarations[0].parameters).toEqual({
      type: "OBJECT", properties: { path: { type: "STRING" } },
    });
    const recursive = translateCodexToGeminiRequest(request([{ role: "user", content: "hi" }], [{
      type: "function", name: "Loop", parameters: {
        $defs: { node: { type: "object", properties: { child: { $ref: "#/$defs/node" } } } },
        $ref: "#/$defs/node",
      },
    }]));
    expect(recursive.tools?.[0].functionDeclarations[0].parameters).toEqual({
      type: "OBJECT", properties: { child: { type: "OBJECT" } },
    });
  });
});
