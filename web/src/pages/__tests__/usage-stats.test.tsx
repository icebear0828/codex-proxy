/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/preact";
import type { UsageDataPoint, UsageSummary } from "../../../../shared/hooks/use-usage-stats";

const mockUsageStats = vi.hoisted(() => ({
  useUsageSummary: vi.fn(),
  useUsageHistory: vi.fn(),
}));

const mockI18n = vi.hoisted(() => ({
  useT: vi.fn(),
}));

vi.mock("../../../../shared/hooks/use-usage-stats", () => ({
  useUsageSummary: mockUsageStats.useUsageSummary,
  useUsageHistory: mockUsageStats.useUsageHistory,
}));

vi.mock("../../../../shared/i18n/context", () => ({
  useT: mockI18n.useT,
}));

import { UsageStats } from "../UsageStats";

const summary: UsageSummary = {
  total_input_tokens: 999_000,
  total_output_tokens: 888_000,
  total_cached_tokens: 777_000,
  total_image_input_tokens: 666_000,
  total_image_output_tokens: 555_000,
  total_image_request_count: 444_000,
  total_image_request_failed_count: 333_000,
  total_request_count: 222_000,
  total_accounts: 5,
  active_accounts: 2,
};

const windowPoints: UsageDataPoint[] = [
  {
    timestamp: "2026-05-08T00:00:00.000Z",
    input_tokens: 1000,
    output_tokens: 200,
    cached_tokens: 500,
    image_input_tokens: 5,
    image_output_tokens: 6,
    image_request_count: 1,
    image_request_failed_count: 0,
    request_count: 2,
  },
  {
    timestamp: "2026-05-08T01:00:00.000Z",
    input_tokens: 2000,
    output_tokens: 500,
    cached_tokens: 700,
    image_input_tokens: 7,
    image_output_tokens: 9,
    image_request_count: 2,
    image_request_failed_count: 1,
    request_count: 5,
  },
];

function renderUsageStats() {
  return render(<UsageStats embedded />);
}

describe("UsageStats", () => {
  beforeEach(() => {
    mockI18n.useT.mockReturnValue((key: string) => {
      const labels: Record<string, string> = {
        totalInputTokens: "Input Tokens",
        totalOutputTokens: "Output Tokens",
        cacheHitRate: "Cache Hit Rate",
        cacheHitRateHint: "{cached} cached / {input} input",
        rangeHitRate: "Range Hit Rate",
        rangeHitRateHint: "Hit rate within the selected window",
        imageTokens: "Image Tokens (in/out)",
        imageTokensHint: "image_generation tool",
        imageRequests: "Image Requests",
        imageRequestsHint: "{ok} ok · {failed} failed",
        totalRequestCount: "Requests",
        activeAccounts: "Active Accounts",
        granularityFiveMin: "5 min",
        granularityHourly: "Hourly",
        granularityDaily: "Daily",
        last1h: "Last 1h",
        last6h: "Last 6h",
        last24h: "Last 24h",
        last3d: "Last 3d",
        last7d: "Last 7d",
        last30d: "Last 30d",
        last90d: "Last 90d",
        allHistory: "All",
      };
      return labels[key] ?? key;
    });
    mockUsageStats.useUsageSummary.mockReturnValue({ summary, loading: false });
    mockUsageStats.useUsageHistory.mockReturnValue({ dataPoints: windowPoints, loading: false });
  });

  afterEach(() => {
    cleanup();
  });

  it("shows selected-window usage totals instead of cumulative summary totals", () => {
    renderUsageStats();

    expect(screen.getByText("3.0K")).toBeTruthy();
    expect(screen.getByText("700")).toBeTruthy();
    expect(screen.getByText("7")).toBeTruthy();
    expect(screen.getByText("12 / 15")).toBeTruthy();
    expect(screen.getByText("3 / 1")).toBeTruthy();
    expect(screen.getByText("2 / 5")).toBeTruthy();

    expect(screen.queryByText("999.0K")).toBeNull();
    expect(screen.queryByText("888.0K")).toBeNull();
    expect(screen.queryByText("222.0K")).toBeNull();
  });
});
