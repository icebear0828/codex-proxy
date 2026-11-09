/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AntigravityAccountSummary } from "../../../shared/hooks/use-accounts";

vi.mock("../../../shared/i18n/context", () => ({
  useT: () => (key: string) => key,
  useI18n: () => ({ lang: "en" }),
}));

import { AntigravityAccounts } from "./AntigravityAccounts";

const account: AntigravityAccountSummary = {
  id: "agy-1",
  label: "Antigravity OAuth",
  email: "tester@gmail.com",
  planType: "Pro",
  status: "active",
  models: ["gemini-pro", "claude-opus"],
  modelCount: 2,
  claudeModelCount: 1,
  geminiModelCount: 1,
  addedAt: "2026-01-01T00:00:00.000Z",
  lastUsedAt: "2026-01-01T01:00:00.000Z",
  requestCount: 4,
  requestTokens: 100,
  imageRequestCount: 1,
  windowRequestCount: 2,
  windowRequestTokens: 60,
  windowImageRequestCount: 1,
  usageWindowStartedAt: "2026-01-01T00:00:00.000Z",
  quota: {
    buckets: [
      { modelId: "gemini-pro", remainingFraction: 0.7, resetTime: "2026-01-01T05:00:00.000Z" },
      { modelId: "claude-opus", remainingFraction: 0.3, resetTime: "2026-01-01T05:00:00.000Z" },
    ],
  },
};

describe("AntigravityAccounts Codex card reuse", () => {
  afterEach(() => cleanup());

  it("uses the same Codex card shell and controls, with shared window-stat rows", () => {
    const { container } = render(
      <AntigravityAccounts
        accounts={[account]}
        onAdd={vi.fn(async () => {})}
        onDelete={vi.fn(async () => null)}
        onToggleStatus={vi.fn(async () => null)}
        onRefresh={vi.fn()}
      />,
    );

    const card = container.querySelector('[class*="rounded-xl"][class*="p-4"][class*="shadow-sm"][class*="hover:shadow-md"]');
    expect(card).toBeTruthy();
    expect(screen.getByText("windowRequests")).toBeTruthy();
    expect(screen.getByText("windowTokens")).toBeTruthy();
    expect(screen.getByText("windowImageRequests")).toBeTruthy();
    expect(screen.getByText("tester@gmail.com")).toBeTruthy();
    expect(screen.getByText("Pro · 1 Claude · 1 Gemini")).toBeTruthy();
    expect(screen.getByTitle("disableAccount")).toBeTruthy();
    expect(screen.getByTitle("refreshQuota")).toBeTruthy();
    expect(screen.getByTitle("deleteAccount")).toBeTruthy();
  });

  it("shows compact per-family quota groups with raw buckets kept expandable", () => {
    const { container } = render(
      <AntigravityAccounts
        accounts={[account]}
        onAdd={vi.fn(async () => {})}
        onDelete={vi.fn(async () => null)}
        onToggleStatus={vi.fn(async () => null)}
        onRefresh={vi.fn()}
      />,
    );

    // Group summaries show the most-constrained bucket of each shared pool.
    expect(screen.getByText("antigravityQuotaGemini")).toBeTruthy();
    expect(screen.getByText("antigravityQuotaClaudeGpt")).toBeTruthy();
    expect(screen.getByTestId("antigravity-quota-group-gemini").getAttribute("style")).toContain("width: 70%");
    expect(screen.getByTestId("antigravity-quota-group-codex").getAttribute("style")).toContain("width: 30%");

    // One expandable summary per group, and raw per-model buckets stay available.
    expect(screen.getAllByText(/antigravityQuotaExpandModels/)).toHaveLength(2);
    expect(screen.getByTestId("antigravity-quota-0").getAttribute("style")).toContain("width: 70%");
    expect(screen.getByTestId("antigravity-quota-1").getAttribute("style")).toContain("width: 30%");
    expect(container.querySelectorAll("details")).toHaveLength(3); // models list + 2 quota groups
  });

  it("does not merge unknown or auxiliary models into the shared pools", () => {
    const extended: AntigravityAccountSummary = {
      ...account,
      quota: {
        buckets: [
          ...account.quota!.buckets,
          { modelId: "aux-helper", remainingFraction: 0.9, resetTime: null },
        ],
      },
    };
    render(
      <AntigravityAccounts
        accounts={[extended]}
        onAdd={vi.fn(async () => {})}
        onDelete={vi.fn(async () => null)}
        onToggleStatus={vi.fn(async () => null)}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByText("antigravityQuotaOther")).toBeTruthy();
    expect(screen.getByTestId("antigravity-quota-group-other").getAttribute("style")).toContain("width: 90%");
    expect(screen.getByTestId("antigravity-quota-group-gemini").getAttribute("style")).toContain("width: 70%");
    expect(screen.getByTestId("antigravity-quota-group-codex").getAttribute("style")).toContain("width: 30%");
  });

  it("never fabricates a percentage when no bucket reports a remaining fraction", () => {
    const depleted: AntigravityAccountSummary = {
      ...account,
      quota: {
        buckets: [
          { modelId: "gemini-pro", remainingFraction: null, resetTime: null },
          { modelId: "claude-opus", remainingFraction: null, resetTime: null },
        ],
      },
    };
    render(
      <AntigravityAccounts
        accounts={[depleted]}
        onAdd={vi.fn(async () => {})}
        onDelete={vi.fn(async () => null)}
        onToggleStatus={vi.fn(async () => null)}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("antigravity-quota-group-gemini")).toBeNull();
    expect(screen.queryByTestId("antigravity-quota-group-codex")).toBeNull();
    // Em-dash placeholder for both group summaries and both raw buckets.
    expect(screen.getAllByText("—").length).toBe(4);
  });
});
