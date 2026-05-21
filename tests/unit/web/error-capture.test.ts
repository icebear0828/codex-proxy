/**
 * Tests for the renderer error-capture pure helpers.
 *
 * The DOM-side `installRendererErrorCapture()` (window.addEventListener,
 * fetch) is not unit-tested here — the codex-proxy convention is to
 * keep frontend tests on pure functions only and verify the wiring
 * end-to-end at integration time. The two builders below carry all
 * the interesting logic (extracting name/message/stack from various
 * shapes); the install function is just a 4-line wrapper around them.
 */

import { describe, it, expect } from "vitest";
import {
  buildRendererErrorReport,
  buildRendererRejectionReport,
} from "../../../web/src/error-capture.js";

describe("buildRendererErrorReport", () => {
  it("extracts name + message + stack from an Error instance", () => {
    const err = new TypeError("oops");
    const report = buildRendererErrorReport({
      error: err,
      message: err.message,
      filename: "/app.js",
      lineno: 42,
      colno: 7,
    });

    expect(report.source).toBe("renderer");
    expect(report.error.name).toBe("TypeError");
    expect(report.error.message).toBe("oops");
    expect(report.error.stack).toBeDefined();
    expect(report.context).toMatchObject({
      filename: "/app.js",
      lineno: 42,
      colno: 7,
    });
  });

  it("falls back to event.message when error is not an Error instance", () => {
    const report = buildRendererErrorReport({
      message: "Script error",
      filename: "/x.js",
    });
    expect(report.error.name).toBe("Error");
    expect(report.error.message).toBe("Script error");
    expect(report.error.stack).toBeUndefined();
  });

  it("uses 'Uncaught error' default when both error and message are absent", () => {
    const report = buildRendererErrorReport({});
    expect(report.error.message).toBe("Uncaught error");
    expect(report.context).toBeUndefined();
  });

  it("preserves a custom error name when present", () => {
    class CustomError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "CustomError";
      }
    }
    const report = buildRendererErrorReport({
      error: new CustomError("boom"),
      message: "boom",
    });
    expect(report.error.name).toBe("CustomError");
  });
});

describe("buildRendererRejectionReport", () => {
  it("extracts name + message + stack when rejection is an Error", () => {
    const reason = new RangeError("out of bounds");
    const report = buildRendererRejectionReport({ reason });
    expect(report.error.name).toBe("RangeError");
    expect(report.error.message).toBe("out of bounds");
    expect(report.error.stack).toBeDefined();
  });

  it("uses the string itself when rejection is a plain string", () => {
    const report = buildRendererRejectionReport({ reason: "auth failed" });
    expect(report.error.name).toBe("UnhandledRejection");
    expect(report.error.message).toBe("auth failed");
  });

  it("JSON-stringifies object rejections", () => {
    const report = buildRendererRejectionReport({
      reason: { code: 500, detail: "server" },
    });
    expect(report.error.message).toContain("500");
    expect(report.error.message).toContain("server");
  });

  it("uses default name + message for empty reasons", () => {
    const report = buildRendererRejectionReport({ reason: undefined });
    expect(report.error.name).toBe("UnhandledRejection");
    expect(report.error.message).toBe("Unhandled promise rejection");
  });
});
