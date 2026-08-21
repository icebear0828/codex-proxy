import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("LogsPage source structure", () => {
  it("includes observability KPI summary cards (TTFT, Speed, Latency, Cost, Tokens)", () => {
    const source = readFileSync(
      resolve(__dirname, "../../../web/src/pages/LogsPage.tsx"),
      "utf-8",
    );

    expect(source).toContain("logsAvgTtft");
    expect(source).toContain("logsAvgSpeed");
    expect(source).toContain("logsAvgLatency");
    expect(source).toContain("logsTotalCost");
    expect(source).toContain("formatSpeed");
    expect(source).toContain("formatCost");
    expect(source).toContain("formatDuration");
  });

  it("includes observability columns and token details breakdown in detail drawer", () => {
    const source = readFileSync(
      resolve(__dirname, "../../../web/src/pages/LogsPage.tsx"),
      "utf-8",
    );

    expect(source).toContain("logsTtft");
    expect(source).toContain("logsSpeed");
    expect(source).toContain("logsCost");
    expect(source).toContain("logsTokensDetail");
    expect(source).toContain("logsPromptTokens");
    expect(source).toContain("logsCompletionTokens");
    expect(source).toContain("logsReasoningTokens");
    expect(source).toContain("logsCachedTokens");
  });
});
