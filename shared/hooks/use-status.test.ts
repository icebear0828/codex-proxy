import { describe, it, expect } from "vitest";
import {
  getFamilyId,
  isTierVariant,
  isSelectableChatModel,
  selectDefaultModel,
  type CatalogModel,
} from "./use-status.js";

describe("use-status helpers", () => {
  describe("getFamilyId", () => {
    it("extracts family from bare model names", () => {
      expect(getFamilyId("gpt-5.4")).toBe("gpt-5.4");
      expect(getFamilyId("gpt-5")).toBe("gpt-5");
    });

    it("identifies spark as a distinct family", () => {
      expect(getFamilyId("gpt-5.3-codex-spark")).toBe("gpt-5.3-codex-spark");
    });

    it("identifies mini as a distinct family", () => {
      expect(getFamilyId("gpt-5.3-codex-mini")).toBe("gpt-5.3-codex-mini");
      expect(getFamilyId("gpt-5-codex-mini")).toBe("gpt-5-codex-mini");
    });

    it("strips tier suffixes (high, mid, low, max) to base family", () => {
      expect(getFamilyId("gpt-5.3-codex-high")).toBe("gpt-5.3-codex");
      expect(getFamilyId("gpt-5.3-codex-mid")).toBe("gpt-5.3-codex");
      expect(getFamilyId("gpt-5.3-codex-low")).toBe("gpt-5.3-codex");
      expect(getFamilyId("gpt-5.3-codex-max")).toBe("gpt-5.3-codex");
      expect(getFamilyId("gpt-5-codex-high")).toBe("gpt-5-codex");
    });
  });

  describe("isTierVariant", () => {
    it("returns true for tier variant IDs", () => {
      expect(isTierVariant("gpt-5.3-codex-high")).toBe(true);
      expect(isTierVariant("gpt-5.3-codex-mid")).toBe(true);
      expect(isTierVariant("gpt-5.3-codex-low")).toBe(true);
      expect(isTierVariant("gpt-5.3-codex-max")).toBe(true);
    });

    it("returns false for base models or spark/mini", () => {
      expect(isTierVariant("gpt-5.4")).toBe(false);
      expect(isTierVariant("gpt-5.3-codex")).toBe(false);
      expect(isTierVariant("gpt-5.3-codex-spark")).toBe(false);
      expect(isTierVariant("gpt-5.3-codex-mini")).toBe(false);
    });
  });

  describe("isSelectableChatModel", () => {
    it("returns true for models with text output and supported reasoning efforts", () => {
      const model: CatalogModel = {
        id: "gpt-5.4",
        displayName: "GPT-5.4",
        isDefault: false,
        supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Medium effort" }],
        defaultReasoningEffort: "medium",
        outputModalities: ["text"],
      };
      expect(isSelectableChatModel(model)).toBe(true);
    });

    it("returns false for non-text output models", () => {
      const model: CatalogModel = {
        id: "image-gen-1",
        displayName: "Image Gen",
        isDefault: false,
        supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Medium effort" }],
        defaultReasoningEffort: "medium",
        outputModalities: ["image"],
      };
      expect(isSelectableChatModel(model)).toBe(false);
    });

    it("returns false for models without reasoning efforts", () => {
      const model: CatalogModel = {
        id: "gpt-5.4",
        displayName: "GPT-5.4",
        isDefault: false,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: "",
        outputModalities: ["text"],
      };
      expect(isSelectableChatModel(model)).toBe(false);
    });
  });

  describe("selectDefaultModel", () => {
    const catalog: CatalogModel[] = [
      {
        id: "gpt-5.3-codex",
        displayName: "GPT-5.3 Codex",
        isDefault: false,
        supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Medium" }],
        defaultReasoningEffort: "medium",
        outputModalities: ["text"],
      },
      {
        id: "gpt-5.4",
        displayName: "GPT-5.4",
        isDefault: true,
        supportedReasoningEfforts: [{ reasoningEffort: "high", description: "High" }],
        defaultReasoningEffort: "high",
        outputModalities: ["text"],
      },
    ];

    it("selects the model marked as isDefault", () => {
      expect(selectDefaultModel(catalog, ["gpt-5.3-codex", "gpt-5.4"])).toBe("gpt-5.4");
    });

    it("falls back to the first selectable model when none is marked isDefault", () => {
      const noDefaultCatalog = catalog.map((m) => ({ ...m, isDefault: false }));
      expect(selectDefaultModel(noDefaultCatalog, ["gpt-5.3-codex", "gpt-5.4"])).toBe("gpt-5.3-codex");
    });

    it("ignores unselectable models marked as isDefault and falls back", () => {
      const unselectableDefaultCatalog: CatalogModel[] = [
        {
          id: "image-only",
          displayName: "Image Only",
          isDefault: true,
          supportedReasoningEfforts: [],
          defaultReasoningEffort: "",
          outputModalities: ["image"],
        },
        {
          id: "gpt-5.4",
          displayName: "GPT-5.4",
          isDefault: false,
          supportedReasoningEfforts: [{ reasoningEffort: "high", description: "High" }],
          defaultReasoningEffort: "high",
          outputModalities: ["text"],
        },
      ];
      expect(selectDefaultModel(unselectableDefaultCatalog, ["image-only", "gpt-5.4"])).toBe("gpt-5.4");
    });

    it("falls back to ids array when catalog is empty", () => {
      expect(selectDefaultModel([], ["gpt-5.4"])).toBe("gpt-5.4");
    });

    it("returns empty string when both catalog and ids are empty", () => {
      expect(selectDefaultModel([], [])).toBe("");
    });
  });
});
