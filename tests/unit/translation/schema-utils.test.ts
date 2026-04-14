import { describe, it, expect } from "vitest";
import { injectAdditionalProperties } from "@src/translation/shared-utils.js";

describe("injectAdditionalProperties", () => {
  it("injects additionalProperties: false on root object", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
    };
    const result = injectAdditionalProperties(schema);
    expect(result.additionalProperties).toBe(false);
  });

  it("injects on nested objects in properties", () => {
    const schema = {
      type: "object",
      properties: {
        user: {
          type: "object",
          properties: {
            name: { type: "string" },
          },
        },
      },
    };
    const result = injectAdditionalProperties(schema);
    expect(result.additionalProperties).toBe(false);
    const user = result.properties as Record<string, Record<string, unknown>>;
    expect(user.user.additionalProperties).toBe(false);
  });

  it("injects on $defs entries (BlindDecision schema pattern)", () => {
    const schema = {
      type: "object",
      properties: {
        decision: { $ref: "#/$defs/Decision" },
      },
      $defs: {
        Decision: {
          type: "object",
          properties: {
            action: { type: "string" },
            confidence: { type: "number" },
          },
          required: ["action", "confidence"],
        },
      },
    };
    const result = injectAdditionalProperties(schema);
    expect(result.additionalProperties).toBe(false);
    const defs = result.$defs as Record<string, Record<string, unknown>>;
    expect(defs.Decision.additionalProperties).toBe(false);
  });

  it("injects on definitions entries", () => {
    const schema = {
      type: "object",
      properties: {},
      definitions: {
        Item: {
          type: "object",
          properties: { id: { type: "number" } },
        },
      },
    };
    const result = injectAdditionalProperties(schema);
    const defs = result.definitions as Record<string, Record<string, unknown>>;
    expect(defs.Item.additionalProperties).toBe(false);
  });

  it("injects on items (array of objects)", () => {
    const schema = {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              value: { type: "string" },
            },
          },
        },
      },
    };
    const result = injectAdditionalProperties(schema);
    const items = (result.properties as Record<string, Record<string, unknown>>).items;
    const inner = items.items as Record<string, unknown>;
    expect(inner.additionalProperties).toBe(false);
  });

  it("injects on oneOf / anyOf / allOf entries", () => {
    const schema = {
      type: "object",
      properties: {
        value: {
          oneOf: [
            { type: "object", properties: { a: { type: "string" } } },
            { type: "string" },
          ],
          anyOf: [
            { type: "object", properties: { b: { type: "number" } } },
          ],
          allOf: [
            { type: "object", properties: { c: { type: "boolean" } } },
          ],
        },
      },
    };
    const result = injectAdditionalProperties(schema);
    const value = (result.properties as Record<string, Record<string, unknown>>).value;
    expect((value.oneOf as Record<string, unknown>[])[0].additionalProperties).toBe(false);
    // string type should not have additionalProperties
    expect((value.oneOf as Record<string, unknown>[])[1]).not.toHaveProperty("additionalProperties");
    expect((value.anyOf as Record<string, unknown>[])[0].additionalProperties).toBe(false);
    expect((value.allOf as Record<string, unknown>[])[0].additionalProperties).toBe(false);
  });

  it("injects on not subschema", () => {
    const schema = {
      not: {
        type: "object",
        properties: { x: { type: "string" } },
      },
    };
    const result = injectAdditionalProperties(schema);
    expect((result.not as Record<string, unknown>).additionalProperties).toBe(false);
  });

  it("injects on prefixItems entries", () => {
    const schema = {
      type: "array",
      prefixItems: [
        { type: "object", properties: { a: { type: "string" } } },
        { type: "number" },
      ],
    };
    const result = injectAdditionalProperties(schema);
    expect((result.prefixItems as Record<string, unknown>[])[0].additionalProperties).toBe(false);
    expect((result.prefixItems as Record<string, unknown>[])[1]).not.toHaveProperty("additionalProperties");
  });

  it("preserves existing additionalProperties (does not overwrite)", () => {
    const schema = {
      type: "object",
      properties: { name: { type: "string" } },
      additionalProperties: true,
    };
    const result = injectAdditionalProperties(schema);
    expect(result.additionalProperties).toBe(true);
  });

  it("preserves additionalProperties: false if already set", () => {
    const schema = {
      type: "object",
      properties: {},
      additionalProperties: false,
    };
    const result = injectAdditionalProperties(schema);
    expect(result.additionalProperties).toBe(false);
  });

  it("does not inject on non-object types", () => {
    const schema = {
      type: "string",
      minLength: 1,
    };
    const result = injectAdditionalProperties(schema);
    expect(result).not.toHaveProperty("additionalProperties");
  });

  it("deep-clones input (does not mutate original)", () => {
    const schema = {
      type: "object",
      properties: {
        nested: {
          type: "object",
          properties: { x: { type: "string" } },
        },
      },
    };
    const result = injectAdditionalProperties(schema);
    // Original should not be mutated
    expect(schema).not.toHaveProperty("additionalProperties");
    expect(
      (schema.properties.nested as Record<string, unknown>).additionalProperties,
    ).toBeUndefined();
    // Result should have injection
    expect(result.additionalProperties).toBe(false);
  });

  it("handles deeply nested schemas", () => {
    const schema = {
      type: "object",
      properties: {
        level1: {
          type: "object",
          properties: {
            level2: {
              type: "object",
              properties: {
                level3: {
                  type: "object",
                  properties: { value: { type: "string" } },
                },
              },
            },
          },
        },
      },
    };
    const result = injectAdditionalProperties(schema);
    expect(result.additionalProperties).toBe(false);
    const l1 = (result.properties as Record<string, Record<string, unknown>>).level1;
    expect(l1.additionalProperties).toBe(false);
    const l2 = (l1.properties as Record<string, Record<string, unknown>>).level2;
    expect(l2.additionalProperties).toBe(false);
    const l3 = (l2.properties as Record<string, Record<string, unknown>>).level3;
    expect(l3.additionalProperties).toBe(false);
  });

  it("handles empty schema gracefully", () => {
    const result = injectAdditionalProperties({});
    expect(result).toEqual({});
  });
});
