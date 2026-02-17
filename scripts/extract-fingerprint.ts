#!/usr/bin/env tsx
/**
 * extract-fingerprint.ts — Extracts key fingerprint values from a Codex Desktop
 * installation (macOS .app or Windows extracted ASAR).
 *
 * Usage:
 *   npx tsx scripts/extract-fingerprint.ts --path "C:/path/to/Codex" [--asar-out ./asar-out]
 *
 * The path can point to:
 *   - A macOS .app bundle (Codex.app)
 *   - A directory containing an already-extracted ASAR (with package.json and .vite/build/main.js)
 *   - A Windows install dir containing resources/app.asar
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, join } from "path";
import { createHash } from "crypto";
import { execSync } from "child_process";
import yaml from "js-yaml";

const ROOT = resolve(import.meta.dirname, "..");
const OUTPUT_PATH = resolve(ROOT, "data/extracted-fingerprint.json");
const PROMPTS_DIR = resolve(ROOT, "data/extracted-prompts");
const PATTERNS_PATH = resolve(ROOT, "config/extraction-patterns.yaml");

interface ExtractionPatterns {
  package_json: { version_key: string; build_number_key: string; sparkle_feed_key: string };
  main_js: Record<string, {
    pattern?: string;
    group?: number;
    global?: boolean;
    start_marker?: string;
    end_marker?: string;
    end_pattern?: string;
    description: string;
  }>;
}

interface ExtractedFingerprint {
  app_version: string;
  build_number: string;
  api_base_url: string | null;
  originator: string | null;
  models: string[];
  wham_endpoints: string[];
  user_agent_contains: string;
  sparkle_feed_url: string | null;
  prompts: {
    desktop_context_hash: string | null;
    desktop_context_path: string | null;
    title_generation_hash: string | null;
    title_generation_path: string | null;
    pr_generation_hash: string | null;
    pr_generation_path: string | null;
    automation_response_hash: string | null;
    automation_response_path: string | null;
  };
  extracted_at: string;
  source_path: string;
}

function sha256(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf-8").digest("hex").slice(0, 16)}`;
}

function loadPatterns(): ExtractionPatterns {
  const raw = yaml.load(readFileSync(PATTERNS_PATH, "utf-8")) as ExtractionPatterns;
  return raw;
}

/**
 * Find the extracted ASAR root given an input path.
 * Tries multiple layout conventions.
 */
function findAsarRoot(inputPath: string): string {
  // Direct: path has package.json (already extracted)
  if (existsSync(join(inputPath, "package.json"))) {
    return inputPath;
  }

  // macOS .app bundle
  const macResources = join(inputPath, "Contents/Resources");
  if (existsSync(join(macResources, "app.asar"))) {
    return extractAsar(join(macResources, "app.asar"));
  }

  // Windows: resources/app.asar
  const winResources = join(inputPath, "resources");
  if (existsSync(join(winResources, "app.asar"))) {
    return extractAsar(join(winResources, "app.asar"));
  }

  // Already extracted: check for nested 'extracted' dir
  const extractedDir = join(inputPath, "extracted");
  if (existsSync(join(extractedDir, "package.json"))) {
    return extractedDir;
  }

  // Check recovered/extracted pattern
  const recoveredExtracted = join(inputPath, "recovered/extracted");
  if (existsSync(join(recoveredExtracted, "package.json"))) {
    return recoveredExtracted;
  }

  throw new Error(
    `Cannot find Codex source at ${inputPath}. Expected package.json or app.asar.`
  );
}

function extractAsar(asarPath: string): string {
  const outDir = resolve(ROOT, ".asar-out");
  console.log(`[extract] Extracting ASAR: ${asarPath} → ${outDir}`);
  execSync(`npx @electron/asar extract "${asarPath}" "${outDir}"`, {
    stdio: "inherit",
  });
  return outDir;
}

/**
 * Step A: Extract from package.json
 */
function extractFromPackageJson(root: string): {
  version: string;
  buildNumber: string;
  sparkleFeedUrl: string | null;
} {
  const pkgPath = join(root, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

  return {
    version: pkg.version ?? "unknown",
    buildNumber: String(pkg.codexBuildNumber ?? "unknown"),
    sparkleFeedUrl: pkg.codexSparkleFeedUrl ?? null,
  };
}

/**
 * Step B: Extract values from main.js using patterns
 */
function extractFromMainJs(
  content: string,
  patterns: ExtractionPatterns["main_js"],
): {
  apiBaseUrl: string | null;
  originator: string | null;
  models: string[];
  whamEndpoints: string[];
  userAgentContains: string;
} {
  // API base URL
  let apiBaseUrl: string | null = null;
  const apiPattern = patterns.api_base_url;
  if (apiPattern?.pattern) {
    const m = content.match(new RegExp(apiPattern.pattern));
    if (m) apiBaseUrl = m[0];
  }

  // Originator
  let originator: string | null = null;
  const origPattern = patterns.originator;
  if (origPattern?.pattern) {
    const m = content.match(new RegExp(origPattern.pattern));
    if (m) originator = m[origPattern.group ?? 0] ?? m[0];
  }

  // Models — deduplicate, use capture group if specified
  const models: Set<string> = new Set();
  const modelPattern = patterns.models;
  if (modelPattern?.pattern) {
    const re = new RegExp(modelPattern.pattern, "g");
    const groupIdx = modelPattern.group ?? 0;
    for (const m of content.matchAll(re)) {
      models.add(m[groupIdx] ?? m[0]);
    }
  }

  // WHAM endpoints — deduplicate, use capture group if specified
  const endpoints: Set<string> = new Set();
  const epPattern = patterns.wham_endpoints;
  if (epPattern?.pattern) {
    const re = new RegExp(epPattern.pattern, "g");
    const epGroupIdx = epPattern.group ?? 0;
    for (const m of content.matchAll(re)) {
      endpoints.add(m[epGroupIdx] ?? m[0]);
    }
  }

  return {
    apiBaseUrl,
    originator,
    models: [...models].sort(),
    whamEndpoints: [...endpoints].sort(),
    userAgentContains: "Codex Desktop/",
  };
}

/**
 * Step B (continued): Extract system prompts from main.js
 */
function extractPrompts(content: string): {
  desktopContext: string | null;
  titleGeneration: string | null;
  prGeneration: string | null;
  automationResponse: string | null;
} {
  // Desktop context: from "# Codex desktop context" to the end of the template literal
  let desktopContext: string | null = null;
  const dcStart = content.indexOf("# Codex desktop context");
  if (dcStart !== -1) {
    // Find the closing backtick of the template literal
    // Look backwards from dcStart for the opening backtick to understand nesting
    // Then scan forward for the matching close
    const afterStart = content.indexOf("`;", dcStart);
    if (afterStart !== -1) {
      desktopContext = content.slice(dcStart, afterStart).trim();
    }
  }

  // Title generation: from the function that builds the array
  let titleGeneration: string | null = null;
  const titleMarker = "You are a helpful assistant. You will be presented with a user prompt";
  const titleStart = content.indexOf(titleMarker);
  if (titleStart !== -1) {
    // Find the enclosing array end: ].join(
    const joinIdx = content.indexOf("].join(", titleStart);
    if (joinIdx !== -1) {
      // Extract the array content between [ and ]
      const bracketStart = content.lastIndexOf("[", titleStart);
      if (bracketStart !== -1) {
        const arrayContent = content.slice(bracketStart + 1, joinIdx);
        // Parse string literals from the array
        titleGeneration = parseStringArray(arrayContent);
      }
    }
  }

  // PR generation
  let prGeneration: string | null = null;
  const prMarker = "You are a helpful assistant. Generate a pull request title";
  const prStart = content.indexOf(prMarker);
  if (prStart !== -1) {
    const joinIdx = content.indexOf("].join(", prStart);
    if (joinIdx !== -1) {
      const bracketStart = content.lastIndexOf("[", prStart);
      if (bracketStart !== -1) {
        const arrayContent = content.slice(bracketStart + 1, joinIdx);
        prGeneration = parseStringArray(arrayContent);
      }
    }
  }

  // Automation response: template literal starting with "Response MUST end with"
  let automationResponse: string | null = null;
  const autoMarker = "Response MUST end with a remark-directive block";
  const autoStart = content.indexOf(autoMarker);
  if (autoStart !== -1) {
    const afterAuto = content.indexOf("`;", autoStart);
    if (afterAuto !== -1) {
      automationResponse = content.slice(autoStart, afterAuto).trim();
    }
  }

  return { desktopContext, titleGeneration, prGeneration, automationResponse };
}

/**
 * Parse a JavaScript string array content into a single joined string.
 * Handles simple quoted strings separated by commas.
 */
function parseStringArray(arrayContent: string): string {
  const lines: string[] = [];
  // Match quoted strings (both single and double quotes) and template literals
  const stringRe = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g;
  for (const m of arrayContent.matchAll(stringRe)) {
    const str = m[1] ?? m[2] ?? "";
    // Unescape common sequences
    lines.push(
      str
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\'/g, "'")
        .replace(/\\\\/g, "\\")
    );
  }
  return lines.join("\n");
}

function savePrompt(name: string, content: string | null): { hash: string | null; path: string | null } {
  if (!content) return { hash: null, path: null };

  mkdirSync(PROMPTS_DIR, { recursive: true });
  const filePath = join(PROMPTS_DIR, `${name}.md`);
  writeFileSync(filePath, content);

  return {
    hash: sha256(content),
    path: filePath,
  };
}

async function main() {
  // Parse --path argument
  const pathIdx = process.argv.indexOf("--path");
  if (pathIdx === -1 || !process.argv[pathIdx + 1]) {
    console.error("Usage: npx tsx scripts/extract-fingerprint.ts --path <codex-path>");
    console.error("");
    console.error("  <codex-path> can be:");
    console.error("    - macOS: /path/to/Codex.app");
    console.error("    - Windows: C:/path/to/Codex (containing resources/app.asar)");
    console.error("    - Extracted: directory with package.json and .vite/build/main.js");
    process.exit(1);
  }

  const inputPath = resolve(process.argv[pathIdx + 1]);
  console.log(`[extract] Input: ${inputPath}`);

  // Find ASAR root
  const asarRoot = findAsarRoot(inputPath);
  console.log(`[extract] ASAR root: ${asarRoot}`);

  // Load extraction patterns
  const patterns = loadPatterns();

  // Step A: package.json
  console.log("[extract] Reading package.json...");
  const { version, buildNumber, sparkleFeedUrl } = extractFromPackageJson(asarRoot);
  console.log(`  version: ${version}`);
  console.log(`  build:   ${buildNumber}`);

  // Step B: main.js
  console.log("[extract] Loading main.js...");
  const mainJs = await (async () => {
    const mainPath = join(asarRoot, ".vite/build/main.js");
    if (!existsSync(mainPath)) {
      console.warn("[extract] main.js not found, skipping JS extraction");
      return null;
    }

    const content = readFileSync(mainPath, "utf-8");
    const lineCount = content.split("\n").length;

    if (lineCount < 100 && content.length > 100000) {
      console.log("[extract] main.js appears minified, attempting beautify...");
      try {
        const jsBeautify = await import("js-beautify");
        return jsBeautify.default.js(content, { indent_size: 2 });
      } catch {
        console.warn("[extract] js-beautify not available, using raw content");
        return content;
      }
    }
    return content;
  })();

  let mainJsResults = {
    apiBaseUrl: null as string | null,
    originator: null as string | null,
    models: [] as string[],
    whamEndpoints: [] as string[],
    userAgentContains: "Codex Desktop/",
  };

  let promptResults = {
    desktopContext: null as string | null,
    titleGeneration: null as string | null,
    prGeneration: null as string | null,
    automationResponse: null as string | null,
  };

  if (mainJs) {
    console.log(`[extract] main.js loaded (${mainJs.split("\n").length} lines)`);

    mainJsResults = extractFromMainJs(mainJs, patterns.main_js);
    console.log(`  API base URL:  ${mainJsResults.apiBaseUrl}`);
    console.log(`  originator:    ${mainJsResults.originator}`);
    console.log(`  models:        ${mainJsResults.models.join(", ")}`);
    console.log(`  WHAM endpoints: ${mainJsResults.whamEndpoints.length} found`);

    // Extract system prompts
    console.log("[extract] Extracting system prompts...");
    promptResults = extractPrompts(mainJs);
    console.log(`  desktop-context:     ${promptResults.desktopContext ? "found" : "NOT FOUND"}`);
    console.log(`  title-generation:    ${promptResults.titleGeneration ? "found" : "NOT FOUND"}`);
    console.log(`  pr-generation:       ${promptResults.prGeneration ? "found" : "NOT FOUND"}`);
    console.log(`  automation-response: ${promptResults.automationResponse ? "found" : "NOT FOUND"}`);
  }

  // Save extracted prompts
  const dc = savePrompt("desktop-context", promptResults.desktopContext);
  const tg = savePrompt("title-generation", promptResults.titleGeneration);
  const pr = savePrompt("pr-generation", promptResults.prGeneration);
  const ar = savePrompt("automation-response", promptResults.automationResponse);

  // Build output
  const fingerprint: ExtractedFingerprint = {
    app_version: version,
    build_number: buildNumber,
    api_base_url: mainJsResults.apiBaseUrl,
    originator: mainJsResults.originator,
    models: mainJsResults.models,
    wham_endpoints: mainJsResults.whamEndpoints,
    user_agent_contains: mainJsResults.userAgentContains,
    sparkle_feed_url: sparkleFeedUrl,
    prompts: {
      desktop_context_hash: dc.hash,
      desktop_context_path: dc.path,
      title_generation_hash: tg.hash,
      title_generation_path: tg.path,
      pr_generation_hash: pr.hash,
      pr_generation_path: pr.path,
      automation_response_hash: ar.hash,
      automation_response_path: ar.path,
    },
    extracted_at: new Date().toISOString(),
    source_path: inputPath,
  };

  // Write output
  mkdirSync(resolve(ROOT, "data"), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(fingerprint, null, 2));

  console.log(`\n[extract] Fingerprint written to ${OUTPUT_PATH}`);
  console.log(`[extract] Prompts written to ${PROMPTS_DIR}/`);
  console.log("[extract] Done.");
}

main().catch((err) => {
  console.error("[extract] Fatal:", err);
  process.exit(1);
});
