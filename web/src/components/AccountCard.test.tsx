/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account, ProxyEntry } from "../../../shared/types";

vi.mock("../../../shared/i18n/context", () => ({
  useT: () => (key: string) => key,
  useI18n: () => ({ lang: "en" }),
}));

import { AccountCard } from "./AccountCard";

function account(mode: "off" | "session" = "off"): Account {
  return {
    id: "account-1",
    email: "user@example.com",
    status: "active",
    codexFingerprintMode: mode,
  };
}

describe("AccountCard Codex fingerprint control", () => {
  afterEach(() => cleanup());

  it("renders convergence off by default", () => {
    render(<AccountCard account={account()} index={0} onDelete={vi.fn(async () => null)} />);

    expect((screen.getByRole("checkbox", { name: "codexSessionConvergence" }) as HTMLInputElement).checked).toBe(false);
  });

  it("requires risk confirmation before enabling session convergence", async () => {
    const update = vi.fn(async () => null);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <AccountCard
        account={account()}
        index={0}
        onDelete={vi.fn(async () => null)}
        onUpdateCodexFingerprintMode={update}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "codexSessionConvergence" }));

    await waitFor(() => expect(update).toHaveBeenCalledWith("account-1", "session"));
    expect(confirmSpy).toHaveBeenCalledWith("codexSessionConvergenceWarning");
  });

  it("keeps convergence visibly off when the risk confirmation is cancelled", () => {
    const update = vi.fn(async () => null);
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <AccountCard
        account={account()}
        index={0}
        onDelete={vi.fn(async () => null)}
        onUpdateCodexFingerprintMode={update}
      />,
    );
    const control = screen.getByRole("checkbox", { name: "codexSessionConvergence" }) as HTMLInputElement;
    fireEvent.click(control);

    expect(control.checked).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });
});

describe("AccountCard proxy selector", () => {
  afterEach(() => cleanup());

  it("does not show disabled proxies", () => {
    const proxies: ProxyEntry[] = [
      { id: "active-proxy", name: "Active proxy", url: "http://active", status: "active", health: null, addedAt: "" },
      { id: "unreachable-proxy", name: "Unreachable proxy", url: "http://unreachable", status: "unreachable", health: null, addedAt: "" },
      { id: "disabled-proxy", name: "Disabled proxy", url: "http://disabled", status: "disabled", health: null, addedAt: "" },
    ];

    const { container } = render(
      <AccountCard
        account={account()}
        index={0}
        onDelete={vi.fn(async () => null)}
        proxies={proxies}
        onProxyChange={vi.fn()}
      />,
    );

    const optionLabels = Array.from(container.querySelectorAll("select option"), (option) => option.textContent);
    expect(optionLabels).toContain("Active proxy");
    expect(optionLabels).toContain("Unreachable proxy");
    expect(optionLabels).not.toContain("Disabled proxy");
  });
});

describe("AccountCard Rate Limit Reset Credits", () => {
  afterEach(() => cleanup());

  it("renders reset credits widget when available count > 0", () => {
    const acct: Account = {
      ...account(),
      quota: {
        rate_limit: { used_percent: 100, limit_reached: true },
        reset_credits_available: 2,
      },
    };

    render(<AccountCard account={acct} index={0} onDelete={vi.fn(async () => null)} />);

    const widget = screen.getByTestId("reset-credits");
    expect(widget).toBeTruthy();
    expect(widget.textContent).toContain("2");
    expect(screen.getByRole("button", { name: "useResetCredit" })).toBeTruthy();
  });

  it("does not render reset credits widget when count is 0 or undefined", () => {
    const acct: Account = {
      ...account(),
      quota: {
        rate_limit: { used_percent: 50, limit_reached: false },
        reset_credits_available: 0,
      },
    };

    render(<AccountCard account={acct} index={0} onDelete={vi.fn(async () => null)} />);

    expect(screen.queryByTestId("reset-credits")).toBeNull();
  });

  it("triggers onConsumeResetCredit when clicking use button and confirmed", async () => {
    const onConsume = vi.fn(async () => null);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    const acct: Account = {
      ...account(),
      quota: {
        rate_limit: { used_percent: 100, limit_reached: true },
        reset_credits_available: 1,
      },
    };

    render(
      <AccountCard
        account={acct}
        index={0}
        onDelete={vi.fn(async () => null)}
        onConsumeResetCredit={onConsume}
      />,
    );

    const btn = screen.getByRole("button", { name: "useResetCredit" });
    fireEvent.click(btn);

    await waitFor(() => expect(onConsume).toHaveBeenCalledWith("account-1"));
  });
});

describe("AccountCard window estimated cost", () => {
  afterEach(() => cleanup());

  it("renders the current primary-window amount below the rate limit", () => {
    const acct: Account = {
      ...account(),
      usage: { window_estimated_cost_usd: 0.0064 },
      quota: {
        rate_limit: { used_percent: 25, limit_reached: false },
      },
    };

    render(<AccountCard account={acct} index={0} onDelete={vi.fn(async () => null)} />);

    const amount = screen.getByTestId("window-estimated-cost");
    expect(amount.textContent).toContain("windowEstimatedCost");
    expect(amount.textContent).toContain("$0.0064");
    expect(amount.getAttribute("title")).toBe("estimatedApiCostHint");
  });

  it("renders a missing window amount as zero", () => {
    render(<AccountCard account={account()} index={0} onDelete={vi.fn(async () => null)} />);

    expect(screen.getByTestId("window-estimated-cost").textContent).toContain("$0.00");
  });
});

