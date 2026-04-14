/**
 * Tests for mutateYaml — atomic YAML file mutation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "fs";
import { mutateYaml } from "@src/utils/yaml-mutate.js";

const mockRead = readFileSync as Mock;
const mockWrite = writeFileSync as Mock;
const mockRename = renameSync as Mock;
const mockExists = existsSync as Mock;
const mockMkdir = mkdirSync as Mock;

beforeEach(() => {
  vi.resetAllMocks();
  mockExists.mockReturnValue(true); // default: file exists
});

describe("mutateYaml", () => {
  it("reads file, applies mutator, writes .tmp, then atomic renames", () => {
    mockRead.mockReturnValue("port: 8080\n");

    mutateYaml("/config/default.yaml", (data) => {
      data.port = 9090;
    });

    expect(mockRead).toHaveBeenCalledWith("/config/default.yaml", "utf-8");
    expect(mockWrite).toHaveBeenCalledOnce();
    expect(mockWrite.mock.calls[0][0]).toBe("/config/default.yaml.tmp");
    expect(mockRename).toHaveBeenCalledWith("/config/default.yaml.tmp", "/config/default.yaml");

    // Verify ordering: write before rename
    const writeOrder = mockWrite.mock.invocationCallOrder[0];
    const renameOrder = mockRename.mock.invocationCallOrder[0];
    expect(writeOrder).toBeLessThan(renameOrder);
  });

  it("mutator receives the parsed YAML object", () => {
    mockRead.mockReturnValue("host: localhost\nport: 3000\n");
    const mutator = vi.fn();

    mutateYaml("/app/config.yaml", mutator);

    expect(mutator).toHaveBeenCalledOnce();
    expect(mutator).toHaveBeenCalledWith({ host: "localhost", port: 3000 });
  });

  it("preserves fields not modified by the mutator", () => {
    mockRead.mockReturnValue("name: proxy\nversion: 1\nenabled: true\n");

    mutateYaml("/app/config.yaml", (data) => {
      data.version = 2;
    });

    const written = mockWrite.mock.calls[0][1] as string;
    expect(written).toContain("name:");
    expect(written).toContain("proxy");
    expect(written).toContain("version:");
    expect(written).toContain("2");
    expect(written).toContain("enabled:");
    expect(written).toContain("true");
  });

  it("creates file and parent directories when file does not exist", () => {
    mockExists.mockReturnValue(false);

    mutateYaml("/data/local.yaml", (data) => {
      data.server = { proxy_api_key: "my-key" };
    });

    expect(mockMkdir).toHaveBeenCalledWith("/data", { recursive: true });
    expect(mockRead).not.toHaveBeenCalled();
    expect(mockWrite).toHaveBeenCalledOnce();
    const written = mockWrite.mock.calls[0][1] as string;
    expect(written).toContain("proxy_api_key");
    expect(written).toContain("my-key");
  });

  it("does not call renameSync when writeFileSync throws", () => {
    mockRead.mockReturnValue("key: value\n");
    mockWrite.mockImplementation(() => {
      throw new Error("ENOSPC: no space left");
    });

    expect(() =>
      mutateYaml("/config.yaml", (data) => {
        data.key = "new";
      }),
    ).toThrow("ENOSPC");
    expect(mockRename).not.toHaveBeenCalled();
  });

  it("uses correct yaml.dump options (lineWidth: -1, quotingType: double-quote)", () => {
    const longValue = "a".repeat(200);
    mockRead.mockReturnValue(`key: value\n`);

    mutateYaml("/config.yaml", (data) => {
      data.long = longValue;
      // Value with special chars forces quoting — verify double quotes (not single)
      data.special = "yes";
    });

    const written = mockWrite.mock.calls[0][1] as string;

    // lineWidth: -1 means no wrapping — the long value should appear on a single line
    const longLine = written.split("\n").find((l) => l.startsWith("long:"));
    expect(longLine).toBeDefined();
    expect(longLine!.length).toBeGreaterThan(200);

    // quotingType: '"' means when quoting is needed, double quotes are used (not single)
    // "yes" is a YAML boolean keyword and must be quoted
    expect(written).toContain('"yes"');
    expect(written).not.toContain("'yes'");

    // Encoding should be utf-8
    expect(mockWrite.mock.calls[0][2]).toBe("utf-8");
  });
});
