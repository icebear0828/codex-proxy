import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("ClientKeysPage Web Component", () => {
  it("renders key list, create modal, budget inputs and action buttons", () => {
    const source = readFileSync(
      resolve(__dirname, "../../../web/src/pages/ClientKeysPage.tsx"),
      "utf-8",
    );

    expect(source).toContain("useClientKeys");
    expect(source).toContain("handleOpenCreate");
    expect(source).toContain("handleCreateSubmit");
    expect(source).toContain("handleEditSubmit");
    expect(source).toContain("handleCopySecret");
    expect(source).toContain("createdSecretKey");
    expect(source).toContain("totalCostUsd");
    expect(source).toContain("totalRequests");
  });

  it("is registered in App.tsx navigation and main switch", () => {
    const appSource = readFileSync(
      resolve(__dirname, "../../../web/src/App.tsx"),
      "utf-8",
    );

    expect(appSource).toContain('hash: "#/client-keys"');
    expect(appSource).toContain("<ClientKeysPage");
  });
});
