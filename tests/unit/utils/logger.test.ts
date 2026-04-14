/**
 * Tests for structured logger (src/utils/logger.ts).
 * Uses vi.resetModules() + vi.stubEnv() to control NODE_ENV/LOG_LEVEL.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

async function importLogger(env: Record<string, string> = {}) {
  vi.resetModules();
  // Set env vars before importing
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
  const mod = await import("@src/utils/logger.js");
  return mod.log;
}

describe("logger — development mode", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("log.info calls console.log with [INFO] prefix in dev mode", async () => {
    const log = await importLogger({ NODE_ENV: "development" });
    log.info("test message");
    expect(console.log).toHaveBeenCalledWith("[INFO]", "test message");
  });

  it("log.warn calls console.warn with [WARN] prefix", async () => {
    const log = await importLogger({ NODE_ENV: "development" });
    log.warn("warning message");
    expect(console.warn).toHaveBeenCalledWith("[WARN]", "warning message");
  });

  it("log.error calls console.error with [ERROR] prefix", async () => {
    const log = await importLogger({ NODE_ENV: "development" });
    log.error("error message");
    expect(console.error).toHaveBeenCalledWith("[ERROR]", "error message");
  });

  it("log.debug calls console.log with [DEBUG] prefix when LOG_LEVEL=debug", async () => {
    const log = await importLogger({ NODE_ENV: "development", LOG_LEVEL: "debug" });
    log.debug("debug info");
    expect(console.log).toHaveBeenCalledWith("[DEBUG]", "debug info");
  });

  it("includes extra object in dev console output", async () => {
    const log = await importLogger({ NODE_ENV: "development" });
    const extra = { method: "POST", path: "/v1/chat" };
    log.info("request", extra);
    expect(console.log).toHaveBeenCalledWith("[INFO]", "request", extra);
  });
});

describe("logger — production mode", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("outputs JSON to stdout for info level", async () => {
    const log = await importLogger({ NODE_ENV: "production" });
    log.info("prod message", { key: "value" });
    expect(stdoutSpy).toHaveBeenCalled();
    const output = (stdoutSpy.mock.calls[0][0] as string).trim();
    const parsed = JSON.parse(output);
    expect(parsed.level).toBe("info");
    expect(parsed.msg).toBe("prod message");
    expect(parsed.key).toBe("value");
    expect(parsed.ts).toBeDefined();
  });

  it("outputs JSON to stderr for error level", async () => {
    const log = await importLogger({ NODE_ENV: "production" });
    log.error("prod error");
    expect(stderrSpy).toHaveBeenCalled();
    const output = (stderrSpy.mock.calls[0][0] as string).trim();
    const parsed = JSON.parse(output);
    expect(parsed.level).toBe("error");
    expect(parsed.msg).toBe("prod error");
  });
});

describe("logger — level filtering", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("suppresses debug when LOG_LEVEL=info", async () => {
    const log = await importLogger({ NODE_ENV: "development", LOG_LEVEL: "info" });
    log.debug("should not appear");
    expect(console.log).not.toHaveBeenCalled();
  });

  it("suppresses info and debug when LOG_LEVEL=warn", async () => {
    const log = await importLogger({ NODE_ENV: "development", LOG_LEVEL: "warn" });
    log.debug("hidden");
    log.info("hidden");
    log.warn("visible");
    expect(console.log).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it("only shows error when LOG_LEVEL=error", async () => {
    const log = await importLogger({ NODE_ENV: "development", LOG_LEVEL: "error" });
    log.debug("hidden");
    log.info("hidden");
    log.warn("hidden");
    log.error("visible");
    expect(console.log).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledOnce();
  });
});
