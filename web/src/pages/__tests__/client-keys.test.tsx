/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/preact";
import type { ClientKeyPublicSummary } from "../../../../shared/types";
import { translations } from "../../../../shared/i18n/translations";

const mockUseClientKeys = vi.hoisted(() => ({
  useClientKeys: vi.fn(),
}));

const mockI18n = vi.hoisted(() => ({
  useT: vi.fn(),
}));

vi.mock("../../../../shared/hooks/use-client-keys", () => ({
  useClientKeys: mockUseClientKeys.useClientKeys,
}));

vi.mock("../../../../shared/i18n/context", () => ({
  useT: mockI18n.useT,
}));

import { ClientKeysPage } from "../ClientKeysPage";

const sampleKey: ClientKeyPublicSummary = {
  id: "ck_test1234",
  name: "Production App Key",
  key_masked: "sk-proxy-••••••••abcd",
  status: "active",
  expires_at: "2026-12-31T23:59:59.000Z",
  max_budget_usd: 50.0,
  used_cost_usd: 12.5,
  max_tokens: 1000000,
  used_tokens: 250000,
  max_concurrency: 5,
  allowed_models: ["gpt-5.4", "gpt-5.3-codex"],
  request_count: 42,
  last_used_at: "2026-08-19T10:00:00.000Z",
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-19T10:00:00.000Z",
};

describe("ClientKeysPage Component", () => {
  const mockCreateKey = vi.fn();
  const mockUpdateKey = vi.fn();
  const mockToggleStatus = vi.fn();
  const mockResetUsage = vi.fn();
  const mockDeleteKey = vi.fn();
  const mockFetchKeys = vi.fn();

  beforeEach(() => {
    mockI18n.useT.mockReturnValue((key: string) => {
      return (translations.en as Record<string, string>)[key] ?? key;
    });

    mockUseClientKeys.useClientKeys.mockReturnValue({
      keys: [sampleKey],
      totalCostUsd: 12.5,
      totalRequests: 42,
      isLoading: false,
      error: null,
      fetchKeys: mockFetchKeys,
      createKey: mockCreateKey,
      updateKey: mockUpdateKey,
      toggleStatus: mockToggleStatus,
      resetUsage: mockResetUsage,
      deleteKey: mockDeleteKey,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders access keys overview and key list table", () => {
    render(<ClientKeysPage />);

    expect(screen.getByText(new RegExp(translations.en.clientKeys, "i"))).toBeTruthy();
    expect(screen.getByText("Production App Key")).toBeTruthy();
    expect(screen.getByText("sk-proxy-••••••••abcd")).toBeTruthy();
    expect(screen.getAllByText(/12\.5000/).length).toBeGreaterThanOrEqual(1);
  });

  it("opens create key modal on click", () => {
    render(<ClientKeysPage />);

    const createBtn = screen.getByText(translations.en.addClientKey);
    fireEvent.click(createBtn);

    expect(screen.getByPlaceholderText(/Frontend Dev Team/i)).toBeTruthy();
  });

  it("renders noClientKeys empty state when keys list is empty", () => {
    mockUseClientKeys.useClientKeys.mockReturnValue({
      keys: [],
      totalCostUsd: 0,
      totalRequests: 0,
      isLoading: false,
      error: null,
      fetchKeys: vi.fn(),
      createKey: vi.fn(),
      updateKey: vi.fn(),
      toggleStatus: vi.fn(),
      resetUsage: vi.fn(),
      deleteKey: vi.fn(),
    });

    render(<ClientKeysPage />);

    expect(screen.getByText(translations.en.noClientKeys)).toBeTruthy();
    expect(screen.queryByText(translations.en.noAccounts)).toBeNull();
  });
});

