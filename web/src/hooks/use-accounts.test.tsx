/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAccounts } from "../../../shared/hooks/use-accounts";

function AccountFingerprintHarness() {
  const accounts = useAccounts();
  return (
    <button
      type="button"
      onClick={() => void accounts.updateCodexFingerprintMode("account/1", "session")}
    >
      enable
    </button>
  );
}

describe("useAccounts Codex fingerprint mode", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("sends the account-scoped session opt-in request", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url === "/auth/accounts?quota=true") {
        return new Response(JSON.stringify({ accounts: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/auth/accounts/account%2F1/codex-fingerprint" && init?.method === "PATCH") {
        return new Response(JSON.stringify({ success: true, mode: "session" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "unexpected request" }), { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AccountFingerprintHarness />);
    fireEvent.click(screen.getByRole("button", { name: "enable" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/auth/accounts/account%2F1/codex-fingerprint",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "session" }),
        },
      );
    });
  });
});
