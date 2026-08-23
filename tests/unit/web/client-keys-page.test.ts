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
    expect(source).toContain("clipboardCopy");
    expect(source).not.toContain("navigator.clipboard.writeText");
  });

  it("ensures LogsPage and UpdateModal use clipboardCopy instead of raw navigator.clipboard", () => {
    const logsSource = readFileSync(
      resolve(__dirname, "../../../web/src/pages/LogsPage.tsx"),
      "utf-8",
    );
    expect(logsSource).toContain("clipboardCopy");
    expect(logsSource).not.toContain("navigator.clipboard.writeText");

    const updateModalSource = readFileSync(
      resolve(__dirname, "../../../web/src/components/UpdateModal.tsx"),
      "utf-8",
    );
    expect(updateModalSource).toContain("clipboardCopy");
    expect(updateModalSource).not.toContain("navigator.clipboard.writeText");
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
