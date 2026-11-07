import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import yaml from "js-yaml";
import { convertLiteLlm, convertOpenRouter } from "../../../.github/scripts/sync-model-pricing.mjs";

describe("sync-model-pricing script & workflow", () => {
  it("workflow file exists and has valid YAML syntax", () => {
    const workflowPath = resolve(process.cwd(), ".github/workflows/sync-model-pricing.yml");
    expect(existsSync(workflowPath)).toBe(true);

    const content = readFileSync(workflowPath, "utf8");
    const parsed = yaml.load(content) as Record<string, unknown>;
    expect(parsed).toBeDefined();
    expect(parsed.name).toBe("Sync model pricing");
  });

  it("converts LiteLLM models accurately in script", () => {
    const input = {
      "test/gpt-5": {
        input_cost_per_token: 0.00000125,
        output_cost_per_token: 0.00001,
        cache_read_input_token_cost: 0.000000125,
      },
    };
    const output = convertLiteLlm(input);
    expect(output["test/gpt-5"]).toEqual({
      input_usd_per_million: 1.25,
      cached_input_usd_per_million: 0.125,
      output_usd_per_million: 10,
    });
    expect(output["gpt-5"]).toEqual({
      input_usd_per_million: 1.25,
      cached_input_usd_per_million: 0.125,
      output_usd_per_million: 10,
    });
  });

  it("converts OpenRouter models accurately in script", () => {
    const input = {
      data: [
        {
          id: "openai/o3-mini",
          pricing: {
            prompt: "0.0000011",
            completion: "0.0000044",
          },
        },
      ],
    };
    const output = convertOpenRouter(input);
    expect(output["openai/o3-mini"]).toEqual({
      input_usd_per_million: 1.1,
      cached_input_usd_per_million: 1.1,
      output_usd_per_million: 4.4,
    });
    expect(output["o3-mini"]).toEqual({
      input_usd_per_million: 1.1,
      cached_input_usd_per_million: 1.1,
      output_usd_per_million: 4.4,
    });
  });
});
