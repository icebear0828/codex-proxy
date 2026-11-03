/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/preact";

const mockSettings = vi.hoisted(() => ({
  useSettings: vi.fn(() => ({ apiKey: "test-api-key" })),
}));

const mockSave = vi.fn().mockResolvedValue(undefined);
const mockReset = vi.fn().mockResolvedValue(undefined);
const mockRefresh = vi.fn().mockResolvedValue(undefined);

const mockGuardData = {
  enabled: false,
  error_codes: ["cyber_policy"],
  message_patterns: ["cybersecurity risk"],
  status_codes: [] as number[],
  ttl_seconds: 3600,
};

let mockQuarantines: Array<{
  conversation_id: string;
  code: string;
  message: string;
  recorded_at: string;
  age_seconds: number;
}> = [];

vi.mock("../../../shared/i18n/context", () => ({
  useT: () => (key: string) => key,
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("../../../shared/hooks/use-settings", () => ({
  useSettings: mockSettings.useSettings,
}));

vi.mock("../../../shared/hooks/use-policy-guard", () => ({
  usePolicyGuardSettings: () => ({
    data: mockGuardData,
    saving: false,
    saved: false,
    error: null,
    save: mockSave,
    load: vi.fn(),
  }),
  usePolicyGuardQuarantines: () => ({
    quarantines: mockQuarantines,
    loading: false,
    error: null,
    refresh: mockRefresh,
    reset: mockReset,
  }),
}));

import { PolicyGuardSettings } from "./PolicyGuardSettings";

beforeEach(() => {
  mockQuarantines = [];
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("PolicyGuardSettings", () => {
  it("renders the configured codes and patterns", () => {
    render(<PolicyGuardSettings />);
    expect((screen.getByDisplayValue("cyber_policy") as HTMLTextAreaElement).value)
      .toBe("cyber_policy");
    expect((screen.getByDisplayValue("cybersecurity risk") as HTMLTextAreaElement).value)
      .toBe("cybersecurity risk");
    expect((screen.getByDisplayValue("3600") as HTMLInputElement).value).toBe("3600");
  });

  it("saves only the toggled field", async () => {
    render(<PolicyGuardSettings />);
    const checkbox = document.getElementById("policy-guard-enabled") as HTMLInputElement;
    fireEvent.click(checkbox);
    // Toggling marks the field dirty, which reveals its save button.
    const saveButton = screen.getAllByRole("button").find((b) => b.getAttribute("title") === "settingSave");
    expect(saveButton).toBeTruthy();
    fireEvent.click(saveButton!);
    await waitFor(() => expect(mockSave).toHaveBeenCalledWith({ enabled: true }));
  });

  it("parses status codes and rejects an out-of-range value locally", async () => {
    render(<PolicyGuardSettings />);
    const input = screen.getByPlaceholderText("400, 403") as HTMLInputElement;

    fireEvent.input(input, { target: { value: "400, 403" } });
    let saveButton = screen.getAllByRole("button").find((b) => b.getAttribute("title") === "settingSave");
    fireEvent.click(saveButton!);
    await waitFor(() => expect(mockSave).toHaveBeenCalledWith({ status_codes: [400, 403] }));

    mockSave.mockClear();
    fireEvent.input(input, { target: { value: "99" } });
    saveButton = screen.getAllByRole("button").find((b) => b.getAttribute("title") === "settingSave");
    fireEvent.click(saveButton!);
    await waitFor(() => expect(screen.getByText("policyGuardErrorStatusCodes")).toBeTruthy());
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("rejects a non-positive quarantine duration locally", async () => {
    render(<PolicyGuardSettings />);
    const input = screen.getByDisplayValue("3600") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "0" } });
    const saveButton = screen.getAllByRole("button").find((b) => b.getAttribute("title") === "settingSave");
    fireEvent.click(saveButton!);
    await waitFor(() => expect(screen.getByText("policyGuardErrorTtl")).toBeTruthy());
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("shows an empty state when nothing is refused", () => {
    render(<PolicyGuardSettings />);
    expect(screen.getByText("policyGuardNoQuarantines")).toBeTruthy();
  });

  it("lists a refused conversation and releases it by id", async () => {
    mockQuarantines = [{
      conversation_id: "12345678-abcd-ef01-2345-6789abcdef01",
      code: "session_blocked_by_cyber_policy",
      message: "This session is blocked by cyber-security policy",
      recorded_at: new Date().toISOString(),
      age_seconds: 42,
    }];
    render(<PolicyGuardSettings />);

    expect(screen.getByText("12345678")).toBeTruthy();
    expect(screen.getByText("session_blocked_by_cyber_policy")).toBeTruthy();
    expect(screen.getByText("42s")).toBeTruthy();

    fireEvent.click(screen.getByText("policyGuardRelease"));
    await waitFor(() => expect(mockReset).toHaveBeenCalledWith({
      conversationId: "12345678-abcd-ef01-2345-6789abcdef01",
    }));
  });

  it("releases everything at once", async () => {
    mockQuarantines = [{
      conversation_id: "conv-a", code: "cyber_policy", message: "m",
      recorded_at: new Date().toISOString(), age_seconds: 5,
    }];
    render(<PolicyGuardSettings />);
    fireEvent.click(screen.getByText("policyGuardReleaseAll"));
    await waitFor(() => expect(mockReset).toHaveBeenCalledWith({ all: true }));
  });
});
