import { describe, expect, it } from "vitest";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import asar from "@electron/asar";
import yaml from "js-yaml";
import { parseCheckUpdateAppcast } from "../../scripts/build/check-update.js";

const ROOT = resolve(import.meta.dirname, "..", "..");
type JsonRecord = Record<string, unknown>;

function script(name: string): string {
  return readFileSync(resolve(ROOT, "scripts", "build", name), "utf-8");
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readYamlRecord(path: string): JsonRecord {
  const parsed = yaml.load(readFileSync(path, "utf-8")) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`${path} must contain a YAML object`);
  }
  return parsed;
}

function requireRecord(parent: JsonRecord, key: string): JsonRecord {
  const value = parent[key];
  if (!isRecord(value)) {
    throw new Error(`${key} must be a YAML object`);
  }
  return value;
}

function requireString(parent: JsonRecord, key: string): string {
  const value = parent[key];
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }
  return value;
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

  it("does not let full-update silently succeed without a Codex source path", () => {
    const content = script("full-update.ts");
    expect(content).toContain("Missing --path");
    expect(content).not.toContain('await runStep("check"');

    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", resolve(ROOT, "scripts/build/full-update.ts")],
      { cwd: ROOT, encoding: "utf-8" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Missing --path");
  });

  it("runs full-update child scripts without relying on tsx being on PATH", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", resolve(ROOT, "scripts/build/full-update.ts"), "--path", ROOT],
      {
        cwd: ROOT,
        encoding: "utf-8",
        env: { ...process.env, PATH: "" },
      },
    );

    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toContain("Expected a Codex Desktop package");
    expect(output).not.toContain("spawn tsx");
    expect(output).not.toContain("ENOENT");
  });

  it("extracts ASAR app paths without relying on npx being on PATH", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "codex-proxy-asar-path-"));

    try {
      const sourceDir = join(tempRoot, "source");
      const resourcesDir = join(tempRoot, "Codex.app", "Contents", "Resources");
      mkdirSync(sourceDir, { recursive: true });
      mkdirSync(resourcesDir, { recursive: true });
      writeFileSync(
        join(sourceDir, "package.json"),
        JSON.stringify({ name: "not-codex", version: "0.0.0" }),
      );

      await asar.createPackage(sourceDir, join(resourcesDir, "app.asar"));

      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", resolve(ROOT, "scripts/build/extract-fingerprint.ts"), "--path", join(tempRoot, "Codex.app")],
        {
          cwd: ROOT,
          encoding: "utf-8",
          env: { ...process.env, PATH: "" },
        },
      );

      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.status).not.toBe(0);
      expect(output).toContain("Expected a Codex Desktop package");
      expect(output).not.toContain("command not found");
      expect(output).not.toContain("ENOENT");
      expect(output).not.toContain("npx");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("tracks extractor pattern config required by npm run extract", () => {
    expect(script("extract-fingerprint.ts")).toContain("scripts/build/extract-fingerprint.ts --path");
    expect(script("extract-fingerprint.ts")).toContain("config/extraction-patterns.yaml");
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

  it("rejects non-Codex package roots during fingerprint extraction", () => {
    const content = script("extract-fingerprint.ts");
    expect(content).toContain("codexBuildNumber");
    expect(content).toContain("Expected a Codex Desktop package");
  });

  it("cleans the default ASAR extraction directory before unpacking", () => {
    const content = script("extract-fingerprint.ts");
    expect(content).toContain('const outDir = resolve(ROOT, ".asar-out");');
    expect(content).toContain("rmSync(outDir, { recursive: true, force: true });");
    expect(content.indexOf("rmSync(outDir")).toBeLessThan(
      content.indexOf("asar.extractAll(asarPath, outDir);"),
    );
  });

  it("keeps model drift review in the update pipeline", () => {
    expect(script("extract-fingerprint.ts")).toContain("models: mainJsResults.models");
    expect(script("apply-update.ts")).toContain("models_added");
    expect(script("types.ts")).toContain("models: string[]");
    expect(script("apply-update.ts")).toContain("const extractedModels = [...new Set(extracted.models)].sort();");
    expect(script("apply-update.ts")).not.toContain('model.includes("codex")');
  });

  it("extracts every current gpt model id shape from quoted Desktop source strings", () => {
    const patterns = readYamlRecord(resolve(ROOT, "config/extraction-patterns.yaml"));
    const mainJs = requireRecord(patterns, "main_js");
    const modelsPattern = requireRecord(mainJs, "models");
    const pattern = requireString(modelsPattern, "pattern");
    const groupValue = modelsPattern.group;
    const groupIndex = typeof groupValue === "number" ? groupValue : 0;

    const modelsYaml = readYamlRecord(resolve(ROOT, "config/models.yaml"));
    const entries = Array.isArray(modelsYaml.models) ? modelsYaml.models : [];
    const modelIds = entries
      .map((entry) => isRecord(entry) ? entry.id : null)
      .filter((id): id is string => typeof id === "string" && id.startsWith("gpt-"));

    expect(modelIds).toContain("gpt-5-codex");
    expect(modelIds).toContain("gpt-5-codex-mini");

    for (const modelId of modelIds) {
      const matches = [...`"${modelId}"`.matchAll(new RegExp(pattern, "g"))]
        .map((match) => match[groupIndex] ?? match[0]);
      expect(matches, `pattern should match ${modelId}`).toContain(modelId);
    }
  });
});
