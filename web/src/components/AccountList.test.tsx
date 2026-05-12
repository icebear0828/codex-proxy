/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/preact";
import type { Account } from "../../../shared/types";

const mockI18n = vi.hoisted(() => ({
  useT: vi.fn(),
  useI18n: vi.fn(),
}));

vi.mock("../../../shared/i18n/context", () => ({
  useT: () => mockI18n.useT(),
  useI18n: () => mockI18n.useI18n(),
}));

vi.mock("./AccountCard", () => ({
  AccountCard: ({ account }: { account: Account }) => <div>{account.email}</div>,
}));

vi.mock("./AccountImportExport", () => ({
  AccountImportExport: () => <div>import-export</div>,
}));

import { AccountList } from "./AccountList";

const STATUS_FILTER_STORAGE_KEY = "codex-proxy-account-list-status-filter";
const EXPAND_ALL_STORAGE_KEY = "codex-proxy-account-list-expand-all";

function makeAccount(id: string, status: string): Account {
  return {
    id,
    email: `${id}@example.com`,
    status,
  };
}

function makeAccounts(total: number, status: string = "active"): Account[] {
  return Array.from({ length: total }, (_, index) => makeAccount(`acct-${index + 1}`, status));
}

function renderAccountList(accounts: Account[]) {
  return render(
    <AccountList
      accounts={accounts}
      loading={false}
      onDelete={vi.fn(async () => null)}
      onRefresh={vi.fn()}
      refreshing={false}
      lastUpdated={null}
    />,
  );
}

function getStorage(): Storage {
  return window.localStorage;
}

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe("AccountList", () => {
  beforeEach(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: createMemoryStorage(),
    });
    getStorage().clear();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ warnings: [] }) })));
    mockI18n.useT.mockImplementation(
      () => (key: string, vars?: Record<string, unknown>) => {
        if (key === "healthCheckResult") return `alive ${vars?.alive} dead ${vars?.dead} skipped ${vars?.skipped}`;
        if (key === "quotaCriticalWarning") return `critical ${vars?.count}`;
        if (key === "quotaWarning") return `warning ${vars?.count}`;
        return key;
      },
    );
    mockI18n.useI18n.mockReturnValue({ lang: "en" });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("reads persisted status filter and expand-all state on initialization", async () => {
    getStorage().setItem(STATUS_FILTER_STORAGE_KEY, "active");
    getStorage().setItem(EXPAND_ALL_STORAGE_KEY, "true");

    renderAccountList([...makeAccounts(11, "active"), makeAccount("expired-1", "expired")]);

    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("active");
    expect(await screen.findByText("11 / 11")).toBeTruthy();
    expect(screen.getByText("collapse")).toBeTruthy();
  });

  it("falls back to all when persisted filter no longer matches any account state", async () => {
    getStorage().setItem(STATUS_FILTER_STORAGE_KEY, "disabled");

    renderAccountList([makeAccount("active-1", "active"), makeAccount("expired-1", "expired")]);

    await waitFor(() => {
      const select = screen.getByRole("combobox") as HTMLSelectElement;
      expect(select.value).toBe("all");
    });
    expect(getStorage().getItem(STATUS_FILTER_STORAGE_KEY)).toBe("all");
  });

  it("round-trips expand-all state through localStorage", async () => {
    renderAccountList(makeAccounts(12, "active"));

    fireEvent.click(screen.getByText("expandAll"));
    await waitFor(() => expect(getStorage().getItem(EXPAND_ALL_STORAGE_KEY)).toBe("true"));
    expect(screen.getByText("12 / 12")).toBeTruthy();

    fireEvent.click(screen.getByText("collapse"));
    await waitFor(() => expect(getStorage().getItem(EXPAND_ALL_STORAGE_KEY)).toBe("false"));
  });

  it("preserves expand-all preference when the filtered list still exceeds one page", async () => {
    getStorage().setItem(EXPAND_ALL_STORAGE_KEY, "true");
    renderAccountList([...makeAccounts(12, "active"), ...makeAccounts(2, "expired")]);

    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "active" },
    });

    await screen.findByText("12 / 12");
    expect(getStorage().getItem(EXPAND_ALL_STORAGE_KEY)).toBe("true");
    expect(screen.getByText("collapse")).toBeTruthy();
  });
});
