import { describe, expect, it, vi } from "vitest";

vi.mock("preact/hooks", () => ({
  useState: vi.fn(),
  useEffect: vi.fn(),
  useCallback: (fn: unknown) => fn,
}));

import { buildClientKeyHeaders } from "./use-client-keys.js";

describe("buildClientKeyHeaders", () => {
  it("sends the master key via x-api-key without overriding HTTP Basic Authorization", () => {
    expect(buildClientKeyHeaders("master-secret")).toEqual({
      "Content-Type": "application/json",
      "x-api-key": "master-secret",
    });
    expect(buildClientKeyHeaders("master-secret")).not.toHaveProperty("Authorization");
  });

  it("only includes the content type when no master key is available", () => {
    expect(buildClientKeyHeaders()).toEqual({
      "Content-Type": "application/json",
    });
  });
});
