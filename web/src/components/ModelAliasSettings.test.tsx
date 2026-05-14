/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/preact";
import { I18nProvider } from "../../../shared/i18n/context";

const mockSettings = vi.hoisted(() => ({
  useSettings: vi.fn(() => ({ apiKey: "pwd" })),
}));

const mockGeneralSettings = vi.hoisted(() => ({
  save: vi.fn(),
  useGeneralSettings: vi.fn(),
}));

vi.mock("../../../shared/hooks/use-settings", () => ({
  useSettings: mockSettings.useSettings,
}));

vi.mock("../../../shared/hooks/use-general-settings", () => ({
  useGeneralSettings: mockGeneralSettings.useGeneralSettings,
}));

import { ModelAliasSettings } from "./ModelAliasSettings";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ModelAliasSettings", () => {
  it("adds a custom alias and saves the complete alias map", () => {
    mockGeneralSettings.useGeneralSettings.mockReturnValue({
      data: {
        model_aliases: {
          "sonnet-local": "gpt-5.4",
        },
      },
      saving: false,
      saved: false,
      error: null,
      save: mockGeneralSettings.save,
    });

    render(
      <I18nProvider>
        <ModelAliasSettings />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByText("Model Aliases"));
    expect(screen.getByDisplayValue("sonnet-local")).toBeTruthy();

    fireEvent.click(screen.getByText("Add alias"));
    const aliasInputs = screen.getAllByPlaceholderText("client-model");
    const targetInputs = screen.getAllByPlaceholderText("gpt-5.5 or openai:gpt-4o");
    fireEvent.input(aliasInputs[1], { target: { value: "openai-fast" } });
    fireEvent.input(targetInputs[1], { target: { value: "openai:gpt-4o" } });
    fireEvent.click(screen.getByText("Submit"));

    expect(mockGeneralSettings.save).toHaveBeenCalledWith({
      model_aliases: {
        "sonnet-local": "gpt-5.4",
        "openai-fast": "openai:gpt-4o",
      },
    });
  });
});
