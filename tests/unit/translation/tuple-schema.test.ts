import { describe, it, expect } from "vitest";
import {
  convertTupleSchemas,
  reconvertTupleValues,
  hasTupleSchemas,
} from "@src/translation/tuple-schema.js";

describe("hasTupleSchemas", () => {
  it("returns false when no prefixItems", () => {
    expect(hasTupleSchemas({ type: "object", properties: { a: { type: "string" } } })).toBe(false);
  });

  it("returns true when prefixItems at top level", () => {
    expect(hasTupleSchemas({ type: "array", prefixItems: [{ type: "number" }] })).toBe(true);
  });

  it("returns true when prefixItems nested in properties", () => {
    const schema = {
      type: "object",
      properties: {
        point: {
          type: "array",
          prefixItems: [{ type: "number" }, { type: "string" }],
        },
      },
    };
    expect(hasTupleSchemas(schema)).toBe(true);
  });

  it("returns true when prefixItems inside items", () => {
    const schema = {
      type: "array",
      items: {
        type: "array",
        prefixItems: [{ type: "number" }],
      },
    };
    expect(hasTupleSchemas(schema)).toBe(true);
  });

  it("returns true when prefixItems inside oneOf", () => {
    const schema = {
      oneOf: [
        { type: "string" },
        { type: "array", prefixItems: [{ type: "number" }] },
      ],
    };
    expect(hasTupleSchemas(schema)).toBe(true);
  });
});

describe("convertTupleSchemas", () => {
  it("does not mutate input", () => {
    const original = {
      type: "object",
      properties: {
        point: {
          type: "array",
          prefixItems: [{ type: "number" }, { type: "string" }],
          items: false,
        },
      },
    };
    const frozen = JSON.parse(JSON.stringify(original));
    convertTupleSchemas(structuredClone(original));
    expect(original).toEqual(frozen);
  });

  it("converts simple tuple to object", () => {
    const schema = {
      type: "array",
      prefixItems: [
        { type: "number" },
        { type: "number" },
        { type: "string" },
      ],
      items: false,
    };
    const result = convertTupleSchemas(structuredClone(schema));
    expect(result).toEqual({
      type: "object",
      properties: {
        "0": { type: "number" },
        "1": { type: "number" },
        "2": { type: "string" },
      },
      required: ["0", "1", "2"],
      additionalProperties: false,
    });
  });

  it("converts tuple nested in object property", () => {
    const schema = {
      type: "object",
      properties: {
        point: {
          type: "array",
          prefixItems: [{ type: "number" }, { type: "string" }],
          items: false,
        },
        name: { type: "string" },
      },
    };
    const result = convertTupleSchemas(structuredClone(schema));
    expect(result.type).toBe("object");
    expect(result.properties).toEqual({
      point: {
        type: "object",
        properties: {
          "0": { type: "number" },
          "1": { type: "string" },
        },
        required: ["0", "1"],
        additionalProperties: false,
      },
      name: { type: "string" },
    });
  });

  it("converts nested tuple (tuple inside tuple element)", () => {
    const schema = {
      type: "array",
      prefixItems: [
        {
          type: "array",
          prefixItems: [{ type: "number" }, { type: "number" }],
          items: false,
        },
        { type: "string" },
      ],
      items: false,
    };
    const result = convertTupleSchemas(structuredClone(schema));
    expect(result).toEqual({
      type: "object",
      properties: {
        "0": {
          type: "object",
          properties: {
            "0": { type: "number" },
            "1": { type: "number" },
          },
          required: ["0", "1"],
          additionalProperties: false,
        },
        "1": { type: "string" },
      },
      required: ["0", "1"],
      additionalProperties: false,
    });
  });

  it("converts tuple inside array items", () => {
    const schema = {
      type: "array",
      items: {
        type: "array",
        prefixItems: [{ type: "number" }, { type: "string" }],
        items: false,
      },
    };
    const result = convertTupleSchemas(structuredClone(schema));
    expect(result).toEqual({
      type: "array",
      items: {
        type: "object",
        properties: {
          "0": { type: "number" },
          "1": { type: "string" },
        },
        required: ["0", "1"],
        additionalProperties: false,
      },
    });
  });

  it("converts tuple inside oneOf", () => {
    const schema = {
      oneOf: [
        { type: "string" },
        {
          type: "array",
          prefixItems: [{ type: "number" }],
          items: false,
        },
      ],
    };
    const result = convertTupleSchemas(structuredClone(schema));
    expect((result.oneOf as Record<string, unknown>[])[1]).toEqual({
      type: "object",
      properties: { "0": { type: "number" } },
      required: ["0"],
      additionalProperties: false,
    });
  });

  it("converts tuple inside $defs", () => {
    const schema = {
      type: "object",
      properties: {
        coord: { $ref: "#/$defs/Coordinate" },
      },
      $defs: {
        Coordinate: {
          type: "array",
          prefixItems: [{ type: "number" }, { type: "number" }],
          items: false,
        },
      },
    };
    const result = convertTupleSchemas(structuredClone(schema));
    expect((result.$defs as Record<string, unknown>).Coordinate).toEqual({
      type: "object",
      properties: {
        "0": { type: "number" },
        "1": { type: "number" },
      },
      required: ["0", "1"],
      additionalProperties: false,
    });
  });

  it("leaves non-tuple schemas unchanged", () => {
    const schema = {
      type: "object",
      properties: {
        names: { type: "array", items: { type: "string" } },
        age: { type: "number" },
      },
    };
    const result = convertTupleSchemas(structuredClone(schema));
    expect(result).toEqual(schema);
  });

  it("handles empty prefixItems", () => {
    const schema = { type: "array", prefixItems: [], items: false };
    const result = convertTupleSchemas(structuredClone(schema));
    expect(result).toEqual({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    });
  });

  it("converts tuple without items: false (open tuple)", () => {
    // prefixItems without items: false means additional items are allowed
    // We still convert to object but note this loses the "additional items" semantics
    const schema = {
      type: "array",
      prefixItems: [{ type: "number" }, { type: "string" }],
    };
    const result = convertTupleSchemas(structuredClone(schema));
    expect(result.type).toBe("object");
    expect(result.properties).toEqual({
      "0": { type: "number" },
      "1": { type: "string" },
    });
    expect(result.required).toEqual(["0", "1"]);
    expect(result.additionalProperties).toBe(false);
  });
});

describe("reconvertTupleValues", () => {
  it("converts object with numeric keys back to array", () => {
    const originalSchema = {
      type: "array",
      prefixItems: [{ type: "number" }, { type: "number" }, { type: "string" }],
      items: false,
    };
    const data = { "0": 40.7, "1": -74.0, "2": "NYC" };
    const result = reconvertTupleValues(data, originalSchema);
    expect(result).toEqual([40.7, -74.0, "NYC"]);
  });

  it("reconverts tuple nested in object", () => {
    const originalSchema = {
      type: "object",
      properties: {
        point: {
          type: "array",
          prefixItems: [{ type: "number" }, { type: "string" }],
          items: false,
        },
        name: { type: "string" },
      },
    };
    const data = { point: { "0": 42, "1": "hello" }, name: "test" };
    const result = reconvertTupleValues(data, originalSchema) as Record<string, unknown>;
    expect(result.point).toEqual([42, "hello"]);
    expect(result.name).toBe("test");
  });

  it("reconverts nested tuples", () => {
    const originalSchema = {
      type: "array",
      prefixItems: [
        {
          type: "array",
          prefixItems: [{ type: "number" }, { type: "number" }],
          items: false,
        },
        { type: "string" },
      ],
      items: false,
    };
    const data = { "0": { "0": 1, "1": 2 }, "1": "label" };
    const result = reconvertTupleValues(data, originalSchema);
    expect(result).toEqual([[1, 2], "label"]);
  });

  it("reconverts array of tuples", () => {
    const originalSchema = {
      type: "array",
      items: {
        type: "array",
        prefixItems: [{ type: "number" }, { type: "string" }],
        items: false,
      },
    };
    const data = [
      { "0": 1, "1": "a" },
      { "0": 2, "1": "b" },
    ];
    const result = reconvertTupleValues(data, originalSchema);
    expect(result).toEqual([
      [1, "a"],
      [2, "b"],
    ]);
  });

  it("handles null values in tuple positions", () => {
    const originalSchema = {
      type: "array",
      prefixItems: [{ type: "number" }, { type: "string" }],
      items: false,
    };
    const data = { "0": null, "1": "hello" };
    const result = reconvertTupleValues(data, originalSchema);
    expect(result).toEqual([null, "hello"]);
  });

  it("returns data unchanged when schema has no tuples", () => {
    const originalSchema = {
      type: "object",
      properties: { name: { type: "string" } },
    };
    const data = { name: "test" };
    const result = reconvertTupleValues(data, originalSchema);
    expect(result).toEqual({ name: "test" });
  });

  it("returns primitive data unchanged", () => {
    const originalSchema = { type: "string" };
    expect(reconvertTupleValues("hello", originalSchema)).toBe("hello");
    expect(reconvertTupleValues(42, originalSchema)).toBe(42);
    expect(reconvertTupleValues(null, originalSchema)).toBe(null);
  });

  it("reconverts tuple inside $defs via $ref", () => {
    const originalSchema = {
      type: "object",
      properties: {
        coord: { $ref: "#/$defs/Coordinate" },
      },
      $defs: {
        Coordinate: {
          type: "array",
          prefixItems: [{ type: "number" }, { type: "number" }],
          items: false,
        },
      },
    };
    const data = { coord: { "0": 40.7, "1": -74.0 } };
    const result = reconvertTupleValues(data, originalSchema) as Record<string, unknown>;
    expect(result.coord).toEqual([40.7, -74.0]);
  });
});
