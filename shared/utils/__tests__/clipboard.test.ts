import { describe, it, expect, vi, afterEach } from "vitest";
import { clipboardCopy } from "../clipboard.js";

describe("clipboardCopy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("safely handles undefined navigator.clipboard in non-secure contexts without throwing", async () => {
    Object.defineProperty(globalThis, "window", {
      value: { isSecureContext: false, prompt: vi.fn() },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "navigator", {
      value: {},
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "document", {
      value: {
        createElement: vi.fn(() => ({
          style: {},
          value: "",
          focus: vi.fn(),
          select: vi.fn(),
          setSelectionRange: vi.fn(),
        })),
        body: {
          appendChild: vi.fn(),
          removeChild: vi.fn(),
        },
        execCommand: vi.fn(() => true),
      },
      configurable: true,
      writable: true,
    });

    await expect(clipboardCopy("secret-token")).resolves.toBe(true);
  });

  it("uses navigator.clipboard.writeText when secure context and available", async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis, "window", {
      value: { isSecureContext: true },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: { writeText: writeTextMock } },
      configurable: true,
      writable: true,
    });

    const result = await clipboardCopy("secret-token");
    expect(result).toBe(true);
    expect(writeTextMock).toHaveBeenCalledWith("secret-token");
  });
});
