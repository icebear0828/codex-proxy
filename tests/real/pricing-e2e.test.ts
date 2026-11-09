import { describe, expect, it } from "vitest";
import { fetchRemotePricingCatalog } from "@src/auth/pricing-sync.js";

describe("Pricing real service E2E", () => {
  it("fetches pricing catalog from real upstream CDN/mirrors >= 3 consecutive times", async () => {
    const urls = [
      "https://cdn.jsdelivr.net/gh/BerriAI/litellm@main/model_prices_and_context_window.json",
    ];

    for (let i = 1; i <= 3; i++) {
      const start = Date.now();
      const catalog = await fetchRemotePricingCatalog({
        urls,
        timeoutMs: 20000,
      });

      expect(catalog).not.toBeNull();
      const modelCount = Object.keys(catalog!).length;
      expect(modelCount).toBeGreaterThan(100);
      expect(modelCount).toBeLessThan(1000);
      expect(catalog!["gpt-5"]).toBeDefined();
      expect(catalog!["claude-sonnet-4-5"]).toBeDefined();
      expect(catalog!["deepseek-chat"]).toBeDefined();
      expect(catalog!["Beam-1.0"]).toBeUndefined();

      const elapsed = Date.now() - start;
      console.log(`[E2E] Iteration ${i}/3 succeeded: ${modelCount} models loaded in ${elapsed}ms`);
    }
  }, 60000);
});
