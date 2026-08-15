/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account } from "../../../shared/types";

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
