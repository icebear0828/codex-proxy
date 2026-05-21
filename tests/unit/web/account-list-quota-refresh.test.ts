import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("AccountList quota refresh", () => {
  it("uses the explicit quota endpoint instead of token refresh", () => {
    const source = readFileSync(
      resolve(__dirname, "../../../web/src/components/AccountList.tsx"),
      "utf-8",
    );

    expect(source).toContain("`/auth/accounts/${encodeURIComponent(id)}/quota`");
    expect(source).not.toContain("`/auth/accounts/${encodeURIComponent(id)}/refresh`");
  });
});
