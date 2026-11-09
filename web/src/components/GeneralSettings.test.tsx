/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/preact";

const mockSettings = vi.hoisted(() => ({
  useSettings: vi.fn(() => ({ apiKey: "test-api-key" })),
}));

const mockSave = vi.fn().mockResolvedValue(undefined);
const mockGeneralSettingsData = {
  host: "127.0.0.1",
  lan_access: false,
  lan_runtime: { host: "127.0.0.1", port: 49152 } as { host: string; port: number } | null,
  lan_ipv4_addresses: ["192.168.1.20", "10.0.0.2"],
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
  mockSave.mockResolvedValue(undefined);
  mockGeneralSettingsData.host = "127.0.0.1";
  mockGeneralSettingsData.lan_access = false;
  mockGeneralSettingsData.lan_runtime = { host: "127.0.0.1", port: 49152 };
  mockGeneralSettingsData.lan_ipv4_addresses = ["192.168.1.20", "10.0.0.2"];
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


describe("desktop LAN access", () => {
  function open() {
    render(<GeneralSettings isDesktop />);
    fireEvent.click(screen.getByText("generalSettings"));
  }
  it("hides LAN controls outside desktop", () => {
    render(<GeneralSettings />);
    fireEvent.click(screen.getByText("generalSettings"));
    expect(screen.queryByLabelText("lanAccessLabel")).toBeNull();
  });
  it("saves only when explicitly requested", async () => {
    open();
    const toggle = screen.getByLabelText("lanAccessLabel") as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    expect(mockSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTitle("settingSave"));
    await waitFor(() => expect(mockSave).toHaveBeenCalledWith({ lan_access: true }));
  });
  it("preserves draft and shows a failed save", async () => {
    mockSave.mockRejectedValueOnce(new Error("disk full"));
    open();
    fireEvent.click(screen.getByLabelText("lanAccessLabel"));
    fireEvent.click(screen.getByTitle("settingSave"));
    await waitFor(() => expect(screen.getByText("disk full")).toBeTruthy());
    expect((screen.getByLabelText("lanAccessLabel") as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByText("settingRestartRequired")).toBeNull();
  });
  it("shows saved but pending restart without usable addresses", () => {
    mockGeneralSettingsData.host = "0.0.0.0";
    mockGeneralSettingsData.lan_access = true;
    open();
    expect(screen.getByText("lanAccessRestart")).toBeTruthy();
    expect(screen.queryByText("http://192.168.1.20:49152/v1")).toBeNull();
  });
  it("copies the actual running port for each interface", async () => {
    mockGeneralSettingsData.host = "0.0.0.0";
    mockGeneralSettingsData.lan_access = true;
    mockGeneralSettingsData.lan_runtime = { host: "0.0.0.0", port: 49152 };
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    open();
    expect(screen.getByText("http://10.0.0.2:49152/v1")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "lanAccessCopy" })[0]);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("http://192.168.1.20:49152/v1"));
  });
  it("reports clipboard errors", async () => {
    mockGeneralSettingsData.host = "0.0.0.0";
    mockGeneralSettingsData.lan_runtime = { host: "0.0.0.0", port: 49152 };
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) }, configurable: true });
    open();
    fireEvent.click(screen.getAllByRole("button", { name: "lanAccessCopy" })[0]);
    await waitFor(() => expect(screen.getByText("lanAccessCopyFailed")).toBeTruthy());
  });
  it("preserves custom hosts on load", () => {
    mockGeneralSettingsData.host = "192.168.1.20";
    open();
    expect(screen.getByText(/lanAccessCustom/)).toBeTruthy();
    expect(mockSave).not.toHaveBeenCalled();
  });
  it("handles no IPv4 candidates", () => {
    mockGeneralSettingsData.host = "0.0.0.0";
    mockGeneralSettingsData.lan_runtime = { host: "0.0.0.0", port: 49152 };
    mockGeneralSettingsData.lan_ipv4_addresses = [];
    open();
    expect(screen.getByText("lanAccessNoAddress")).toBeTruthy();
  });
  it("does not claim active service with unknown runtime", () => {
    mockGeneralSettingsData.lan_runtime = null;
    open();
    expect(screen.getByText("lanAccessUnknown")).toBeTruthy();
    expect(screen.queryByText("lanAccessActive")).toBeNull();
  });
});
