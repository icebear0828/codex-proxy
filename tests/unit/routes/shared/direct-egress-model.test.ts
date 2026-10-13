/**
 * Issue #848 regression, direct/fallback upstream path.
 *
 * `handleDirectRequest` serves both API-key upstreams and the last-resort
 * fallback account, and it writes the egress audit row itself. That row's model
 * must name what went on the wire — not the display name chat.ts puts on
 * `ProxyRequest.model` (which re-appends the local `-high` / `-fast` suffixes).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { buildDisplayModelName, parseModelName } from "@src/models/model-store.js";
import type { FormatAdapter, ProxyRequest } from "@src/routes/shared/proxy-handler-types.js";
import { createMockFormatAdapter } from "@helpers/format-adapter.js";

vi.mock("@src/logs/entry.js", () => ({
  enqueueLogEntry: vi.fn(),
  updateLogEntry: vi.fn(),
}));

const logsEntryModule = await import("@src/logs/entry.js");
const { handleDirectRequest } = await import("@src/routes/shared/direct-request-handler.js");

const enqueueLogEntryMock = vi.mocked(logsEntryModule.enqueueLogEntry);

/** Mirrors the ProxyRequest chat.ts assembles for a client model name. */
function requestFor(clientModel: string): ProxyRequest {
  const parsed = parseModelName(clientModel);
  return {
    model: buildDisplayModelName(parsed),
    isStreaming: false,
    codexRequest: {
      model: parsed.modelId,
      input: [{ role: "user", content: "hello" }],
      instructions: "system",
      stream: false,
      store: false,
    },
  };
}

async function drive(req: ProxyRequest, fmt: FormatAdapter = createMockFormatAdapter()): Promise<void> {
  const upstream = {
    tag: "fallback",
    createResponse: vi.fn(async () => new Response("{}", { status: 200 })),
  };
  const app = new Hono();
  app.post("/test", (c) => handleDirectRequest({ c: c as never, upstream: upstream as never, req, fmt }));
  await app.request("/test", { method: "POST" });
}

function egressEntry() {
  return enqueueLogEntryMock.mock.calls
    .map(([entry]) => entry)
    .find((entry) => entry.direction === "egress");
}

describe("handleDirectRequest egress model (issue #848)", () => {
  beforeEach(() => {
    enqueueLogEntryMock.mockReset();
  });

  it("logs the resolved upstream model for a suffixed request, not the display name", async () => {
    await drive(requestFor("gpt-6-high"));

    const entry = egressEntry();
    expect(entry?.model).toBe("gpt-6-astra");
    expect(entry?.model).not.toBe("gpt-6-astra-high");
    expect(entry?.request).toMatchObject({ model: "gpt-6-astra" });
  });

  it("records the resolved model for a -fast request", async () => {
    await drive(requestFor("gpt-6-fast"));

    expect(egressEntry()?.model).toBe("gpt-6-astra");
  });

  it("leaves a model that carries no local suffix unchanged", async () => {
    await drive(requestFor("gpt-6-astra"));

    expect(egressEntry()?.model).toBe("gpt-6-astra");
  });
});
