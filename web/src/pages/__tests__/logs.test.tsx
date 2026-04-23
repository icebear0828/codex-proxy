/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/preact";
import { I18nProvider } from "../../../../shared/i18n/context";

const mockLogs = vi.hoisted(() => ({
  useLogs: vi.fn(),
}));

const mockSettings = vi.hoisted(() => ({
  useSettings: vi.fn(() => ({ apiKey: null })),
}));

const mockGeneralSettings = vi.hoisted(() => ({
  useGeneralSettings: vi.fn(),
}));

vi.mock("../../../../shared/hooks/use-logs", () => ({
  useLogs: mockLogs.useLogs,
}));

vi.mock("../../../../shared/hooks/use-settings", () => ({
  useSettings: mockSettings.useSettings,
}));

vi.mock("../../../../shared/hooks/use-general-settings", () => ({
  useGeneralSettings: mockGeneralSettings.useGeneralSettings,
}));

import { LogsPage } from "../LogsPage";

function makeGeneralSettings(overrides: Record<string, unknown> = {}) {
  return {
    data: { logs_llm_only: true },
    saving: false,
    save: vi.fn(),
    ...overrides,
  };
}

function makeLogsState(overrides: Partial<ReturnType<typeof mockLogs.useLogs>> = {}) {
  return {
    records: [
      {
        id: "1",
        requestId: "r1",
        direction: "ingress",
        ts: "2026-04-15T00:00:01.000Z",
        method: "POST",
        path: "/v1/messages",
        status: 200,
        latencyMs: 10,
      },
    ],
    total: 1,
    loading: false,
    state: { enabled: true, paused: false },
    setLogState: vi.fn(),
    selected: null,
    selectLog: vi.fn(),
    direction: "all",
    setDirection: vi.fn(),
    search: "",
    setSearch: vi.fn(),
    page: 0,
    pageSize: 50,
    prevPage: vi.fn(),
    nextPage: vi.fn(),
    hasPrev: false,
    hasNext: true,
    ...overrides,
  };
}

function renderLogsPage() {
  return render(
    <I18nProvider>
      <LogsPage embedded />
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe("LogsPage", () => {
  it("renders pagination controls and invokes page handlers", () => {
    const nextPage = vi.fn();
    mockLogs.useLogs.mockReturnValue(makeLogsState({ nextPage, hasNext: true }));
    mockGeneralSettings.useGeneralSettings.mockReturnValue(makeGeneralSettings());

    renderLogsPage();

    expect(screen.getByText("1 logs")).toBeTruthy();
    expect(screen.getByText("1 total · 1-1")).toBeTruthy();
    fireEvent.click(screen.getByText("Next"));
    expect(nextPage).toHaveBeenCalledTimes(1);
  });

  it("shows selected log details and clears to hint when nothing is selected", () => {
    mockGeneralSettings.useGeneralSettings.mockReturnValue(makeGeneralSettings());

    mockLogs.useLogs.mockReturnValue(makeLogsState({ selected: { id: "1", path: "/v1/messages" } }));
    const { rerender } = renderLogsPage();
    expect(screen.getByText(/"path": "\/v1\/messages"/)).toBeTruthy();

    mockLogs.useLogs.mockReturnValue(makeLogsState({ selected: null }));
    rerender(
      <I18nProvider>
        <LogsPage embedded />
      </I18nProvider>,
    );
    expect(screen.getByText("Select a log to view details")).toBeTruthy();
  });

  it("renders zero latency as 0ms", () => {
    mockLogs.useLogs.mockReturnValue(
      makeLogsState({
        records: [
          {
            id: "1",
            requestId: "r1",
            direction: "ingress",
            ts: "2026-04-15T00:00:01.000Z",
            method: "GET",
            path: "/v1/models",
            status: 200,
            latencyMs: 0,
          },
        ],
      }),
    );
    mockGeneralSettings.useGeneralSettings.mockReturnValue(makeGeneralSettings());

    renderLogsPage();

    expect(screen.getByText("0ms")).toBeTruthy();
  });

  it("renders and toggles the logs mode button", () => {
    const save = vi.fn();
    mockLogs.useLogs.mockReturnValue(makeLogsState());
    mockGeneralSettings.useGeneralSettings.mockReturnValue(makeGeneralSettings({ save }));

    renderLogsPage();

    fireEvent.click(screen.getByText("Only record LLM logs (click to toggle)"));
    expect(save).toHaveBeenCalledWith({ logs_llm_only: false });
  });
});
