import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("AccountList quota refresh", () => {
  it("uses the explicit quota endpoint instead of token refresh", () => {
    const source = readFileSync(
      resolve(__dirname, "../../../web/src/components/AccountList.tsx"),
      "utf-8",
    );

    expect(source).toContain("`/auth/accounts/${encoded}/quota`");
    expect(source).toContain("console.warn");
    expect(source).not.toContain("`/auth/accounts/${encoded}/refresh`");
  });

  it("does not request bulk fresh quota from the account list hook", () => {
    const source = readFileSync(
      resolve(__dirname, "../../../shared/hooks/use-accounts.ts"),
      "utf-8",
    );

    expect(source).toContain("\"/auth/accounts?quota=true\"");
    expect(source).not.toContain("quota=fresh");
  });
});
