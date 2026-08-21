/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/preact";

const mockI18n = vi.hoisted(() => ({
  useT: vi.fn(),
}));

vi.mock("../../../shared/i18n/context", () => ({
  useT: () => mockI18n.useT(),
}));

import { AccountImportExport } from "./AccountImportExport";

describe("AccountImportExport", () => {
  beforeEach(() => {
    mockI18n.useT.mockReturnValue((key: string) => key);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("exports with the selected compatibility format", async () => {
    const onExport = vi.fn(async () => undefined);

    render(
      <AccountImportExport
        onExport={onExport}
        onImport={vi.fn()}
        selectedIds={new Set(["acct-1"])}
      />,
    );

    fireEvent.change(screen.getByLabelText("exportFormat"), {
      target: { value: "sub2api" },
    });
    fireEvent.click(screen.getByTitle("exportBtn (1)"));

    await waitFor(() => {
      expect(onExport).toHaveBeenCalledWith(["acct-1"], "sub2api");
    });
  });

  it("shows the first concrete import error instead of only the failed count", async () => {
    const onImport = vi.fn(async () => ({
      success: true,
      added: 0,
      updated: 0,
      failed: 1,
      errors: ["Account identity discovery failed: HTTP 403"],
    }));
    const { container } = render(
      <AccountImportExport
        onExport={vi.fn()}
        onImport={onImport}
        selectedIds={new Set()}
      />,
    );
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["{}"], "account.json", { type: "application/json" });

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByText(/Account identity discovery failed: HTTP 403/)).toBeTruthy();
    });
  });
});
