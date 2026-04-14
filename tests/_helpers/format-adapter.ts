import { vi } from "vitest";
import type { FormatAdapter } from "@src/routes/shared/proxy-handler.js";

export function createMockFormatAdapter(overrides?: Partial<FormatAdapter>): FormatAdapter {
  return {
    tag: "Test",
    noAccountStatus: 503,
    formatNoAccount: vi.fn(() => ({ error: "no_account" })),
    format429: vi.fn((msg: string) => ({ error: "rate_limited", message: msg })),
    formatError: vi.fn((status: number, msg: string) => ({ error: "api_error", status, message: msg })),
    streamTranslator: vi.fn(async function* (
      _api: unknown,
      _resp: unknown,
      _model: string,
      onUsage: (u: { input_tokens: number; output_tokens: number }) => void,
    ) {
      onUsage({ input_tokens: 10, output_tokens: 20 });
      yield "data: {}\n\n";
      yield "data: [DONE]\n\n";
    }),
    collectTranslator: vi.fn(async () => ({
      response: { id: "resp_1", choices: [] },
      usage: { input_tokens: 10, output_tokens: 20 },
      responseId: "resp_1",
    })),
    ...overrides,
  };
}
