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

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { resolve, join } from "path";
import { createHash } from "crypto";
import { execSync } from "child_process";
import yaml from "js-yaml";
import type { ExtractedFingerprint } from "./types.js";

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
  electronVersion: string | null;
} {
  const pkgPath = join(root, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

  return {
    version: pkg.version ?? "unknown",
    buildNumber: String(pkg.codexBuildNumber ?? "unknown"),
    sparkleFeedUrl: pkg.codexSparkleFeedUrl ?? null,
    electronVersion: pkg.devDependencies?.electron ?? null,
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

  // Fail fast on critical fields
  if (!apiBaseUrl) {
    console.error("[extract] CRITICAL: Failed to extract API base URL from main.js");
    console.error("[extract] The extraction pattern may need updating for this version.");
    throw new Error("Failed to extract critical field: api_base_url");
  }

  // Originator
  let originator: string | null = null;
  const origPattern = patterns.originator;
  if (origPattern?.pattern) {
    const m = content.match(new RegExp(origPattern.pattern));
    if (m) originator = m[origPattern.group ?? 0] ?? m[0];
  }

  // Fail fast on critical fields
  if (!originator) {
    console.error("[extract] CRITICAL: Failed to extract originator from main.js");
    console.error("[extract] The extraction pattern may need updating for this version.");
    throw new Error("Failed to extract critical field: originator");
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
 * Find the nearest `[` bracket within maxDistance chars before the given position.
 * Prevents unbounded `lastIndexOf("[")` from matching a wrong bracket thousands of chars away.
 */
function findNearbyBracket(content: string, position: number, maxDistance = 50): number {
  const searchStart = Math.max(0, position - maxDistance);
  const slice = content.slice(searchStart, position);
  const idx = slice.lastIndexOf("[");
  return idx !== -1 ? searchStart + idx : -1;
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
  // Desktop context: from "# Codex desktop context" to the end of the template literal.
  // In minified code the closing backtick may be followed by `,` `;` or `)` — simple
  // indexOf("`;") can match the wrong position.  Instead, walk line-by-line and stop
  // at the first line that looks like minified JS (identifier assignment, JS keyword).
  let desktopContext: string | null = null;
  const dcStart = content.indexOf("# Codex desktop context");
  if (dcStart !== -1) {
    const remaining = content.slice(dcStart);
    const lines = remaining.split("\n");
    const cleanLines: string[] = [];
    for (const line of lines) {
      // Detect minified JS: consecutive punctuation/whitespace followed by identifier assignment
      if (/^[`,;)\]}\s]+[A-Za-z_$]/.test(line)) break;
      if (/^[`'";}\])\s]*(?:async\s+)?(?:function|class|const|let|var|return|throw|if|for|while)\b/.test(line)) break;
      cleanLines.push(line);
    }
    if (cleanLines.length > 0) {
      cleanLines[cleanLines.length - 1] = cleanLines[cleanLines.length - 1].replace(/`\s*$/, "");
    }
    desktopContext = cleanLines.join("\n").trim() || null;
  }

  // Title generation: from the function that builds the array
  let titleGeneration: string | null = null;
  const titleMarker = "You are a helpful assistant. You will be presented with a user prompt";
  const titleStart = content.indexOf(titleMarker);
  if (titleStart !== -1) {
    // Find the enclosing array end: ].join(
    const joinIdx = content.indexOf("].join(", titleStart);
    if (joinIdx !== -1) {
      // Find the opening [ within 50 chars before the marker (not unbounded lastIndexOf)
      const bracketStart = findNearbyBracket(content, titleStart);
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
      const bracketStart = findNearbyBracket(content, prStart);
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
    const autoRemaining = content.slice(autoStart);
    const autoLines = autoRemaining.split("\n");
    const autoClean: string[] = [];
    for (const line of autoLines) {
      if (/^[`,;)\]}\s]+[A-Za-z_$]/.test(line)) break;
      if (/^[`'";}\])\s]*(?:async\s+)?(?:function|class|const|let|var|return|throw|if|for|while)\b/.test(line)) break;
      autoClean.push(line);
    }
    if (autoClean.length > 0) {
      autoClean[autoClean.length - 1] = autoClean[autoClean.length - 1].replace(/`\s*$/, "");
    }
    automationResponse = autoClean.join("\n").trim() || null;
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

/** Safety net: strip any trailing minified JS that slipped through extraction. */
function sanitizePrompt(raw: string): string {
  const lines = raw.split("\n");
  const clean: string[] = [];
  for (const line of lines) {
    if (/^[`,;)\]}\s]*[A-Za-z_$][A-Za-z0-9_$]*\s*=/.test(line)) break;
    if (/^[`'";}\])\s]*(?:async\s+)?(?:function|class|const|let|var|return|throw|if|for|while)\b/.test(line)) break;
    clean.push(line);
  }
  if (clean.length > 0) {
    clean[clean.length - 1] = clean[clean.length - 1].replace(/`\s*$/, "");
  }
  return clean.join("\n").trim();
}

function savePrompt(name: string, content: string | null): { hash: string | null; path: string | null } {
  if (!content) return { hash: null, path: null };

  const sanitized = sanitizePrompt(content);
  if (!sanitized) return { hash: null, path: null };

  // Validate: reject suspiciously short or garbled content
  if (sanitized.length < 50) {
    console.warn(`[extract] Prompt "${name}" too short (${sanitized.length} chars), skipping save`);
    return { hash: null, path: null };
  }
  const garbageLines = sanitized.split("\n").filter((l) => /^[,`'"]\s*$/.test(l.trim()));
  if (garbageLines.length > 3) {
    console.warn(`[extract] Prompt "${name}" has ${garbageLines.length} garbled lines, skipping save`);
    return { hash: null, path: null };
  }

  mkdirSync(PROMPTS_DIR, { recursive: true });
  const filePath = join(PROMPTS_DIR, `${name}.md`);
  writeFileSync(filePath, sanitized);

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
  const { version, buildNumber, sparkleFeedUrl, electronVersion } = extractFromPackageJson(asarRoot);
  console.log(`  version:  ${version}`);
  console.log(`  build:    ${buildNumber}`);
  console.log(`  electron: ${electronVersion ?? "not found"}`);

  // Resolve Chromium version from Electron version
  let chromiumVersion: string | null = null;
  if (electronVersion) {
    const electronMajor = parseInt(electronVersion.replace(/^[^0-9]*/, ""), 10);
    if (!isNaN(electronMajor)) {
      try {
        const { versions } = await import("electron-to-chromium");
        const versionMap = versions as Record<string, string>;
        // versions keys use "major.minor" format (e.g. "40.0"), try both
        const chromium = versionMap[`${electronMajor}.0`] ?? versionMap[electronMajor.toString()];
        if (chromium) {
          chromiumVersion = chromium;
          console.log(`  chromium: ${chromiumVersion} (from electron ${electronMajor})`);
        } else {
          console.warn(`[extract] No Chromium mapping for Electron ${electronMajor}`);
        }
      } catch {
        console.warn("[extract] electron-to-chromium not available, skipping chromium resolution");
      }
    }
  }

  // Step B: main.js (or main-XXXXX.js chunk)
  console.log("[extract] Loading main.js...");
  const mainJs = await (async () => {
    const buildDir = join(asarRoot, ".vite/build");
    // Find the main JS: prefer main-*.js chunk (Vite code-split), fall back to main.js
    let mainPath = join(buildDir, "main.js");
    if (existsSync(buildDir)) {
      const files = readdirSync(buildDir);
      const chunk = files.find((f) => /^main-[A-Za-z0-9_-]+\.js$/.test(f));
      if (chunk) {
        mainPath = join(buildDir, chunk);
        console.log(`[extract] Found chunk: ${chunk}`);
      }
    }
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

    try {
      mainJsResults = extractFromMainJs(mainJs, patterns.main_js);
    } catch (err) {
      console.warn(`[extract] Primary extraction failed: ${(err as Error).message}`);
      console.log("[extract] Scanning all .vite/build/*.js for fallback...");

      const buildDir = join(asarRoot, ".vite/build");
      if (existsSync(buildDir)) {
        const jsFiles = readdirSync(buildDir).filter((f) => f.endsWith(".js"));
        for (const file of jsFiles) {
          const content = readFileSync(join(buildDir, file), "utf-8");
          const origPattern = patterns.main_js.originator;
          if (origPattern?.pattern) {
            const m = content.match(new RegExp(origPattern.pattern));
            if (m) {
              mainJsResults.originator = m[origPattern.group ?? 0] ?? m[0];
              console.log(`[extract] Originator found in fallback file: ${file}`);
              break;
            }
          }
        }
      }

      // Re-extract non-critical fields from mainJs
      const apiPattern = patterns.main_js.api_base_url;
      if (apiPattern?.pattern) {
        const m = mainJs.match(new RegExp(apiPattern.pattern));
        if (m) mainJsResults.apiBaseUrl = m[0];
      }
      const modelPattern = patterns.main_js.models;
      if (modelPattern?.pattern) {
        const re = new RegExp(modelPattern.pattern, "g");
        const groupIdx = modelPattern.group ?? 0;
        const modelSet = new Set<string>();
        for (const m of mainJs.matchAll(re)) {
          modelSet.add(m[groupIdx] ?? m[0]);
        }
        mainJsResults.models = [...modelSet].sort();
      }
    }

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

  // Scan webview assets for additional model IDs
  const webviewAssetsDir = join(asarRoot, "webview/assets");
  if (existsSync(webviewAssetsDir)) {
    console.log("[extract] Scanning webview assets for additional models...");
    const modelPattern = patterns.main_js.models;
    if (modelPattern?.pattern) {
      const webviewFiles = readdirSync(webviewAssetsDir).filter((f) => f.endsWith(".js"));
      const webviewModels = new Set<string>();
      for (const file of webviewFiles) {
        const content = readFileSync(join(webviewAssetsDir, file), "utf-8");
        const re = new RegExp(modelPattern.pattern, "g");
        const groupIdx = modelPattern.group ?? 0;
        for (const m of content.matchAll(re)) {
          webviewModels.add(m[groupIdx] ?? m[0]);
        }
      }
      const existingModels = new Set(mainJsResults.models);
      const newFromWebview = [...webviewModels].filter((m) => !existingModels.has(m));
      if (newFromWebview.length > 0) {
        console.log(`[extract] Webview: ${newFromWebview.length} additional models: ${newFromWebview.join(", ")}`);
        mainJsResults.models = [...mainJsResults.models, ...newFromWebview].sort();
      }
    }
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
    electron_version: electronVersion,
    chromium_version: chromiumVersion,
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
