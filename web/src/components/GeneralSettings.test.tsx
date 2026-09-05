/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/preact";

const mockSettings = vi.hoisted(() => ({
  useSettings: vi.fn(() => ({ apiKey: "test-api-key" })),
}));

const mockSave = vi.fn().mockResolvedValue(undefined);
const mockGeneralSettingsData = {
  port: 8080,
  proxy_url: null,
  force_http11: false,
  inject_desktop_context: false,
  suppress_desktop_directives: false,
  allow_client_system_prompt_strategy: false,
  system_prompt_strategy: "instructions" as const,
  default_model: "gpt-5.4",
  image_host_model: "gpt-5.5",
  image_host_model_allowed_models: ["gpt-5.4", "gpt-5.5"],
  default_reasoning_effort: null,
  model_aliases: {},
  refresh_enabled: true,
  refresh_margin_seconds: 300,
  refresh_concurrency: 2,
  max_concurrent_per_account: 3,
  request_interval_ms: 50,
  auto_update: true,
  auto_download: false,
  show_update_dialog: false,
  allow_prerelease: false,
  logs_enabled: false,
  logs_capacity: 2000,
  logs_capture_body: false,
  logs_llm_only: true,
  usage_history_retention_days: null,
  credits_per_usd: 25,
};

vi.mock("../../../shared/i18n/context", () => ({
  useT: () => (key: string) => key,
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("../../../shared/hooks/use-settings", () => ({
  useSettings: mockSettings.useSettings,
}));

vi.mock("../../../shared/hooks/use-general-settings", () => ({
  useGeneralSettings: () => ({
    data: mockGeneralSettingsData,
    saving: false,
    saved: false,
    error: null,
    restartRequired: false,
    save: mockSave,
  }),
}));

import { GeneralSettings } from "./GeneralSettings";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("GeneralSettings - allow_prerelease", () => {
  it("renders allow_prerelease checkbox with default false", () => {
    render(<GeneralSettings />);

    // Expand section first
    const toggleButton = screen.getByText("generalSettings");
    fireEvent.click(toggleButton);

    const checkbox = document.getElementById("allow-prerelease") as HTMLInputElement;
    expect(checkbox).not.toBeNull();
    expect(checkbox.checked).toBe(false);
  });

  it("allows toggling allow_prerelease and saving the setting", async () => {
    render(<GeneralSettings />);

    // Expand section
    const toggleButton = screen.getByText("generalSettings");
    fireEvent.click(toggleButton);

    const checkbox = document.getElementById("allow-prerelease") as HTMLInputElement;
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);

    const saveButton = screen.getByTitle("settingSave");
    expect(saveButton).not.toBeNull();
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(mockSave).toHaveBeenCalledWith({ allow_prerelease: true });
    });
  });
});
