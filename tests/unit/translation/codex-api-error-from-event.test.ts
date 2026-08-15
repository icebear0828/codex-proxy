import { describe, expect, it } from "vitest";
import { codexApiErrorFromEvent } from "@src/translation/codex-api-error-from-event.js";

describe("codexApiErrorFromEvent", () => {
  it("maps server_is_overloaded to HTTP 503", () => {
    const err = codexApiErrorFromEvent({
      code: "server_is_overloaded",
      message: "The server is overloaded",
    });

    expect(err.status).toBe(503);
    expect(err.body).toContain("server_is_overloaded");
  });
});
