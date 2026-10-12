import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";

let tmpDataDir = "";
const mockConfig = {
  logs: { enabled: true },
  observability: { request_log_file: true, max_log_bytes: 1024 * 1024 },
};

vi.mock("@src/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@src/paths.js")>();
  return { ...actual, getDataDir: () => tmpDataDir };
});

vi.mock("@src/config.js", () => ({ getConfig: () => mockConfig }));

beforeEach(() => {
  tmpDataDir = mkdtempSync(resolve(tmpdir(), "request-log-"));
  mockConfig.logs.enabled = true;
  mockConfig.observability.request_log_file = true;
  mockConfig.observability.max_log_bytes = 1024 * 1024;
  process.env.VITEST_FORCE_REQUEST_LOG_FILE = "1";
  vi.resetModules();
});

afterEach(() => {
  if (existsSync(tmpDataDir)) rmSync(tmpDataDir, { recursive: true, force: true });
  delete process.env.VITEST_FORCE_REQUEST_LOG_FILE;
  vi.clearAllMocks();
});

describe("appendRequestLogRecord", () => {
  it("persists a JSONL record after redacting credentials", async () => {
    const { appendRequestLogRecord } = await import("@src/logs/request-log-file.js");
    appendRequestLogRecord({
      id: "record-1",
      requestId: "request-1",
      direction: "ingress",
      ts: "2026-10-12T00:00:00.000Z",
      method: "POST",
      path: "/v1/messages",
      status: 200,
      request: { headers: { authorization: "Bearer secret-token-123456" }, body: { prompt: "hello" } },
    });

    const file = resolve(tmpDataDir, "request-log.jsonl");
    expect(existsSync(file)).toBe(true);
    const [line] = readFileSync(file, "utf-8").trim().split("\n");
    const record = JSON.parse(line) as {
      requestId: string;
      status: number;
      request: { headers: { authorization: string }; body: { prompt: string } };
    };
    expect(record.requestId).toBe("request-1");
    expect(record.status).toBe(200);
    expect(record.request.headers.authorization).not.toContain("secret-token");
    expect(record.request.body.prompt).toBe("hello");
  });

  it("does not write when request logging is disabled", async () => {
    mockConfig.logs.enabled = false;
    const { appendRequestLogRecord } = await import("@src/logs/request-log-file.js");
    appendRequestLogRecord({
      id: "record-2",
      requestId: "request-2",
      direction: "egress",
      ts: "2026-10-12T00:00:00.000Z",
      method: "POST",
      path: "/v1internal:streamGenerateContent",
    });
    expect(existsSync(resolve(tmpDataDir, "request-log.jsonl"))).toBe(false);
  });
});
