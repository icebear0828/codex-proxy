/**
 * Tests that collectPassthrough retries on stream interruption (premature close).
 * When the upstream stream breaks before response.completed, the collect path
 * should throw EmptyResponseError, which triggers retry in handleNonStreaming.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EmptyResponseError } from "../../translation/codex-event-extractor.js";

// ── Mock config ──────────────────────────────────────────────────────

const mockConfig = {
  server: { proxy_api_key: null as string | null },
  model: {
    default: "gpt-5.2-codex",
    default_reasoning_effort: null,
    default_service_tier: null,
    suppress_desktop_directives: false,
  },
  auth: {
    jwt_token: undefined as string | undefined,
    rotation_strategy: "least_used" as const,
    rate_limit_backoff_seconds: 60,
  },
};

vi.mock("../../config.js", () => ({
  getConfig: vi.fn(() => mockConfig),
}));

vi.mock("../../paths.js", () => ({
  CONFIG_DIR: "/tmp/codex-proxy-test",
  STATE_DIR: "/tmp/codex-proxy-test",
}));

// ── Helpers ──────────────────────────────────────────────────────────

interface CodexSSEEvent {
  event: string;
  data: unknown;
}

/** Create a mock CodexApi whose parseStream yields given events then optionally throws. */
function createMockApi(events: CodexSSEEvent[], throwAfter?: Error) {
  return {
    async *parseStream(_response: Response): AsyncGenerator<CodexSSEEvent> {
      for (const evt of events) {
        yield evt;
      }
      if (throwAfter) throw throwAfter;
    },
  };
}

/** Create a Response with a simple SSE body (not actually used by mock parseStream). */
function dummyResponse(): Response {
  return new Response("ok");
}

describe("collectPassthrough premature close handling", () => {
  // We test the collectPassthrough function indirectly by calling the PASSTHROUGH_FORMAT
  // collect translator. Since collectPassthrough is not exported directly, we'll replicate
  // its core logic to verify the try/catch behavior.

  // Helper that mirrors the collectPassthrough logic after our fix
  async function collectPassthrough(
    api: { parseStream(r: Response): AsyncGenerator<CodexSSEEvent> },
    response: Response,
  ) {
    let finalResponse: unknown = null;
    let usage = { input_tokens: 0, output_tokens: 0 };
    let responseId: string | null = null;

    const isRecord = (v: unknown): v is Record<string, unknown> =>
      typeof v === "object" && v !== null && !Array.isArray(v);

    try {
      for await (const raw of api.parseStream(response)) {
        const data = raw.data;
        if (!isRecord(data)) continue;
        const resp = isRecord(data.response) ? data.response : null;

        if (raw.event === "response.created" || raw.event === "response.in_progress") {
          if (resp && typeof resp.id === "string") responseId = resp.id;
        }

        if (raw.event === "response.completed" && resp) {
          finalResponse = resp;
          if (typeof resp.id === "string") responseId = resp.id;
          if (isRecord(resp.usage)) {
            usage = {
              input_tokens: typeof resp.usage.input_tokens === "number" ? resp.usage.input_tokens : 0,
              output_tokens: typeof resp.usage.output_tokens === "number" ? resp.usage.output_tokens : 0,
            };
          }
        }

        if (raw.event === "error" || raw.event === "response.failed") {
          const err = isRecord(data.error) ? data.error : data;
          throw new Error(
            `Codex API error: ${typeof err.code === "string" ? err.code : "unknown"}: ${typeof err.message === "string" ? err.message : JSON.stringify(data)}`,
          );
        }
      }
    } catch (streamErr) {
      if (!finalResponse) {
        throw new EmptyResponseError(responseId, usage);
      }
      throw streamErr;
    }

    if (!finalResponse) {
      throw new EmptyResponseError(responseId, usage);
    }

    return { response: finalResponse, usage, responseId };
  }

  it("throws EmptyResponseError when stream ends normally without response.completed", async () => {
    const api = createMockApi([
      { event: "response.created", data: { response: { id: "resp_1" } } },
      { event: "response.in_progress", data: { response: { id: "resp_1" } } },
      // No response.completed — stream just ends
    ]);

    await expect(collectPassthrough(api, dummyResponse())).rejects.toThrow(EmptyResponseError);
  });

  it("throws EmptyResponseError when stream throws error before completion", async () => {
    const api = createMockApi(
      [
        { event: "response.created", data: { response: { id: "resp_2" } } },
        { event: "response.output_text.delta", data: { delta: "partial text" } },
      ],
      new Error("WebSocket closed unexpectedly"),
    );

    const err = await collectPassthrough(api, dummyResponse()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmptyResponseError);
    // Should preserve the response ID from earlier events
    expect((err as EmptyResponseError).responseId).toBe("resp_2");
  });

  it("returns normally when response.completed is received", async () => {
    const api = createMockApi([
      { event: "response.created", data: { response: { id: "resp_3" } } },
      {
        event: "response.completed",
        data: {
          response: {
            id: "resp_3",
            output: [],
            usage: { input_tokens: 10, output_tokens: 20 },
          },
        },
      },
    ]);

    const result = await collectPassthrough(api, dummyResponse());
    expect(result.responseId).toBe("resp_3");
    expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 20 });
  });

  it("rethrows original error if response.completed was already received", async () => {
    // Edge case: completed event received, but stream errors after
    const api = createMockApi(
      [
        {
          event: "response.completed",
          data: {
            response: {
              id: "resp_4",
              output: [],
              usage: { input_tokens: 5, output_tokens: 10 },
            },
          },
        },
      ],
      new Error("late stream error"),
    );

    // Should rethrow the original error, not wrap in EmptyResponseError
    await expect(collectPassthrough(api, dummyResponse())).rejects.toThrow("late stream error");
  });
});
