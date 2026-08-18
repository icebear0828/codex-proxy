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

  it("maps server_error to HTTP 500", () => {
    const err = codexApiErrorFromEvent({
      code: "server_error",
      message: "The server had an internal error",
    });

    expect(err.status).toBe(500);
    expect(err.body).toContain("server_error");
  });
});
