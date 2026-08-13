/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/preact";
import type { OfficialQuotaResponse, UsageDataPoint, UsageSummary } from "../../../../shared/hooks/use-usage-stats";

const mockUsageStats = vi.hoisted(() => ({
  useUsageSummary: vi.fn(),
  useUsageHistory: vi.fn(),
  useUsageQuota: vi.fn(),
}));

const mockI18n = vi.hoisted(() => ({
  useT: vi.fn(),
}));

vi.mock("../../../../shared/hooks/use-usage-stats", () => ({
  useUsageSummary: mockUsageStats.useUsageSummary,
  useUsageHistory: mockUsageStats.useUsageHistory,
  useUsageQuota: mockUsageStats.useUsageQuota,
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
  total_estimated_cost_usd: 111.11,
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
    estimated_cost_usd: 0.12,
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
    estimated_cost_usd: 0.34,
    request_count: 5,
  },
];

const quota: OfficialQuotaResponse = {
  accounts: [{
    account: { id: "account-1", email: "one@example.com", label: "One", plan_type: "plus" },
    quota: {
      plan_type: "plus",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        used_percent: 29,
        remaining_percent: 71,
        reset_at: 1786628370,
        limit_window_seconds: 18000,
      },
      secondary_rate_limit: {
        limit_reached: false,
        used_percent: 5,
        remaining_percent: 95,
        reset_at: 1787215170,
        limit_window_seconds: 604800,
      },
      code_review_rate_limit: null,
      credits: { has_credits: false, unlimited: false, overage_limit_reached: false, balance: 0 },
    },
    error: null,
  }],
};

function renderUsageStats() {
  return render(<UsageStats embedded />);
}

describe("UsageStats", () => {
  beforeEach(() => {
    mockI18n.useT.mockReturnValue((key: string) => {
      const labels: Record<string, string> = {
        totalInputTokens: "Input Tokens",
        totalOutputTokens: "Output Tokens",
        estimatedApiCost: "Estimated API Cost",
        estimatedApiCostHint: "Based on official API prices",
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
        officialQuota: "Official Codex Quota",
        primaryRemaining: "Primary Remaining",
        weeklyRemaining: "Weekly Remaining",
        creditsBalance: "Credit Balance",
        noQuotaData: "No live quota data",
        refresh: "Refresh",
      };
      return labels[key] ?? key;
    });
    mockUsageStats.useUsageSummary.mockReturnValue({ summary, loading: false });
    mockUsageStats.useUsageHistory.mockReturnValue({ dataPoints: windowPoints, loading: false });
    mockUsageStats.useUsageQuota.mockReturnValue({ data: quota, loading: false, error: null, refresh: vi.fn() });
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

  it("shows official remaining quota and credit balance", () => {
    renderUsageStats();

    expect(screen.getByText("Official Codex Quota")).toBeTruthy();
    expect(screen.getByText("71%", { exact: false })).toBeTruthy();
    expect(screen.getByText("95%", { exact: false })).toBeTruthy();
    const creditLabel = screen.getByText("Credit Balance");
    expect(creditLabel).toBeTruthy();
    expect(within(creditLabel.parentElement as HTMLElement).getByText("0")).toBeTruthy();
  });

  it("shows estimated API cost for the selected history window", () => {
    renderUsageStats();

    const costLabel = screen.getByText("Estimated API Cost");
    expect(costLabel).toBeTruthy();
    expect(within(costLabel.parentElement as HTMLElement).getByText("$0.46")).toBeTruthy();
  });

  it("shows a retryable error when live quota cannot be fetched", () => {
    mockUsageStats.useUsageQuota.mockReturnValue({ data: null, loading: false, error: "Unable to fetch quota", refresh: vi.fn() });
    renderUsageStats();

    expect(screen.getByText("Unable to fetch quota")).toBeTruthy();
  });
});
