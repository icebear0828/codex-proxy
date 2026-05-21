import { describe, it, expect } from "vitest";
import { clearErrorLogsRequest, formatRelativeTime } from "./use-error-logs.js";

describe("formatRelativeTime", () => {
  const now = new Date("2026-05-10T12:00:00Z").getTime();

  it("returns 'just now' for very recent timestamps", () => {
    expect(formatRelativeTime("2026-05-10T11:59:58Z", now)).toBe("just now");
  });

  it("returns seconds for under a minute", () => {
    expect(formatRelativeTime("2026-05-10T11:59:30Z", now)).toBe("30s ago");
  });

  it("returns minutes for under an hour", () => {
    expect(formatRelativeTime("2026-05-10T11:30:00Z", now)).toBe("30m ago");
  });

  it("returns hours for under a day", () => {
    expect(formatRelativeTime("2026-05-10T08:00:00Z", now)).toBe("4h ago");
  });

  it("returns days for ≥24h", () => {
    expect(formatRelativeTime("2026-05-08T12:00:00Z", now)).toBe("2d ago");
  });

  it("returns the raw timestamp string when input is not a valid date", () => {
    expect(formatRelativeTime("not-a-date", now)).toBe("not-a-date");
  });
});

describe("clearErrorLogsRequest", () => {
  it("sends a collection DELETE to the error log endpoint", async () => {
    const fetchImpl = async (
      input: string,
      init: RequestInit,
    ): Promise<Pick<Response, "ok">> => {
      expect(input).toBe("/admin/error-logs");
      expect(init).toEqual({ method: "DELETE" });
      return { ok: true };
    };

    await expect(clearErrorLogsRequest(fetchImpl)).resolves.toBe(true);
  });
});
