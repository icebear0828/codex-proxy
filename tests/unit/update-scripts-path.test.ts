import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { parseCheckUpdateAppcast } from "../../scripts/build/check-update.js";

const ROOT = resolve(import.meta.dirname, "..", "..");

function script(name: string): string {
  return readFileSync(resolve(ROOT, "scripts", "build", name), "utf-8");
}

describe("update scripts path resolution", () => {
  it("resolves repository root from scripts/build", () => {
    for (const name of ["check-update.ts", "full-update.ts", "apply-update.ts", "extract-fingerprint.ts"]) {
      expect(script(name), name).toContain('const ROOT = resolve(import.meta.dirname, "..", "..");');
    }
  });

  it("imports root src utilities from apply-update", () => {
    expect(script("apply-update.ts")).toContain('from "../../src/utils/yaml-mutate.js"');
    expect(script("apply-update.ts")).not.toContain('from "../src/utils/yaml-mutate.js"');
  });

  it("tracks extractor pattern config required by npm run extract", () => {
    expect(existsSync(resolve(ROOT, "config", "extraction-patterns.yaml"))).toBe(true);
    expect(readFileSync(resolve(ROOT, ".gitignore"), "utf-8")).not.toContain("config/extraction-patterns.yaml");
  });

  it("keeps extracted prompt type fields aligned with extractor output", () => {
    const types = script("types.ts");
    const extractor = script("extract-fingerprint.ts");

    const typedPromptFields = [
      ...types.matchAll(/^\s{4}([a-z_]+): string \| null;/gm),
    ].map((match) => match[1]);
    const emittedPromptFields = [
      ...extractor.matchAll(/^\s{6}([a-z_]+):/gm),
    ].map((match) => match[1]);

    expect(typedPromptFields).toEqual(emittedPromptFields);
  });

  it("parses current appcast element syntax in check-update", () => {
    const appcast = `
      <rss>
        <channel>
          <item>
            <sparkle:shortVersionString>26.506.31421</sparkle:shortVersionString>
            <sparkle:version>2620</sparkle:version>
            <enclosure url="https://example.com/Codex.zip" />
          </item>
        </channel>
      </rss>
    `;

    expect(parseCheckUpdateAppcast(appcast)).toEqual({
      version: "26.506.31421",
      build: "2620",
      downloadUrl: "https://example.com/Codex.zip",
    });
  });
});
