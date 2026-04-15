import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/preact";

const mockLogs = vi.hoisted(() => ({
  useLogs: vi.fn(),
}));

const mockT = vi.hoisted(() => ({
  useT: vi.fn(),
}));

vi.mock("../../../shared/hooks/use-logs", () => ({
  useLogs: mockLogs.useLogs,
}));

vi.mock("../../../shared/i18n/context", () => ({
  useT: () => mockT.useT(),
}));

import { LogsPage } from "../LogsPage";

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

describe("LogsPage", () => {
  it("renders pagination controls and invokes page handlers", () => {
    const nextPage = vi.fn();
    mockT.useT.mockImplementation(() => (key: string, vars?: Record<string, unknown>) => {
      if (key === "logsCount") return `${vars?.count ?? 0} logs`;
      return key;
    });
    mockLogs.useLogs.mockReturnValue(makeLogsState({ nextPage, hasNext: true }));

    render(<LogsPage embedded />);

    expect(screen.getByText("1 total · 1-1")).toBeTruthy();
    fireEvent.click(screen.getByText("Next"));
    expect(nextPage).toHaveBeenCalledTimes(1);
  });

  it("shows selected log details and clears to hint when nothing is selected", () => {
    mockT.useT.mockImplementation(() => (key: string, vars?: Record<string, unknown>) => {
      if (key === "logsCount") return `${vars?.count ?? 0} logs`;
      return key;
    });

    mockLogs.useLogs.mockReturnValue(makeLogsState({ selected: { id: "1", path: "/v1/messages" } }));
    const { rerender } = render(<LogsPage embedded />);
    expect(screen.getByText(/"path": "\/v1\/messages"/)).toBeTruthy();

    mockLogs.useLogs.mockReturnValue(makeLogsState({ selected: null }));
    rerender(<LogsPage embedded />);
    expect(screen.getByText("logsSelectHint")).toBeTruthy();
  });
});
