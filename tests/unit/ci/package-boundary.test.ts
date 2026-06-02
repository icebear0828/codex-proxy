import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

type JsonRecord = Record<string, unknown>;

const ROOT = resolve(__dirname, "..", "..", "..");
const LOCKFILE_PATHS = ["package-lock.json", "web/package-lock.json", "native/package-lock.json"] as const;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonRecord(path: string): JsonRecord {
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return parsed;
}

function requireRecord(parent: JsonRecord, key: string): JsonRecord {
  const value = parent[key];
  if (!isRecord(value)) {
    throw new Error(`${key} must be a JSON object`);
  }
  return value;
}

function requireStringArray(parent: JsonRecord, key: string): string[] {
  const value = parent[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${key} must be a string array`);
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

function collectNonNpmRegistrySources(lockfilePath: string): string[] {
  const lockfile = readJsonRecord(resolve(ROOT, lockfilePath));
  const packages = requireRecord(lockfile, "packages");
  const disallowedSources: string[] = [];

  for (const [packagePath, packageInfo] of Object.entries(packages)) {
    if (!isRecord(packageInfo)) continue;
    const resolved = packageInfo.resolved;
    if (typeof resolved !== "string") continue;
    if (!resolved.startsWith("http://") && !resolved.startsWith("https://")) continue;

    const host = new URL(resolved).host;
    if (host !== "registry.npmjs.org") {
      disallowedSources.push(`${lockfilePath}:${packagePath}:${host}`);
    }
  }

  return disallowedSources;
}

describe("root package boundary", () => {
  const pkg = readJsonRecord(resolve(ROOT, "package.json"));
  const lock = readJsonRecord(resolve(ROOT, "package-lock.json"));
  const electronPkg = readJsonRecord(resolve(ROOT, "packages/electron/package.json"));
  const lockPackages = requireRecord(lock, "packages");
  const lockRoot = requireRecord(lockPackages, "");
  const lockElectron = requireRecord(lockPackages, "packages/electron");
  const scripts = requireRecord(pkg, "scripts");

  it("keeps the root package identified as codex-proxy", () => {
    expect(pkg.name).toBe("codex-proxy");
    expect(lock.name).toBe("codex-proxy");
    expect(lockRoot.name).toBe("codex-proxy");
    expect(pkg.productName).toBeUndefined();
    expect(pkg.main).toBeUndefined();
  });

  it("keeps package.json and package-lock.json root metadata in sync", () => {
    expect(lock.version).toBe(pkg.version);
    expect(lockRoot.version).toBe(pkg.version);
    expect(lockElectron.version).toBe(electronPkg.version);
    expect(requireStringArray(pkg, "workspaces")).toEqual(["packages/*"]);
    expect(requireStringArray(lockRoot, "workspaces")).toEqual(["packages/*"]);
    expect(pkg.type).toBe("module");
  });

  it("keeps codex-proxy npm entrypoints available", () => {
    expect(requireString(scripts, "test")).toBe("vitest run");
    expect(requireString(scripts, "test:unit")).toBe("vitest run --include 'tests/unit/**/*.test.ts'");
    expect(requireString(scripts, "test:e2e")).toBe("vitest run --include 'tests/e2e/**/*.test.ts'");
    expect(requireString(scripts, "test:integration")).toBe("vitest run --include 'tests/integration/**/*.test.ts'");
    expect(requireString(scripts, "build:web")).toBe("cd web && npx vite build");
    expect(requireString(scripts, "build")).toBe("npm run build:web && tsc");
    expect(requireString(scripts, "typecheck:scripts")).toBe("tsc -p tsconfig.scripts.json");
    expect(requireString(scripts, "dev")).toBe("tsx watch src/index.ts");
    expect(requireString(scripts, "start")).toBe("node dist/index.js");
  });

  it("keeps local tsx package scripts pointing at files in this repository", () => {
    for (const [name, command] of Object.entries(scripts)) {
      if (typeof command !== "string") continue;
      const match = /^tsx ([^ ]+\.ts)(?: |$)/.exec(command);
      if (!match) continue;
      expect(existsSync(resolve(ROOT, match[1])), `script ${name} points to ${match[1]}`).toBe(true);
    }
  });

  it("keeps runtime update script dependencies available after production prune", () => {
    const dependencies = requireRecord(pkg, "dependencies");
    const devDependencies = requireRecord(pkg, "devDependencies");
    const lockRootDependencies = requireRecord(lockRoot, "dependencies");
    const lockRootDevDependencies = requireRecord(lockRoot, "devDependencies");
    const asarLockPackage = requireRecord(lockPackages, "node_modules/@electron/asar");
    const dockerfile = readFileSync(resolve(ROOT, "Dockerfile"), "utf-8");

    expect(dockerfile).toContain("npm prune --omit=dev");
    expect(dockerfile).toContain("npm install --no-save tsx");
    expect(dependencies["@electron/asar"]).toBeDefined();
    expect(lockRootDependencies["@electron/asar"]).toBeDefined();
    expect(devDependencies["@electron/asar"]).toBeUndefined();
    expect(lockRootDevDependencies["@electron/asar"]).toBeUndefined();
    expect(asarLockPackage.dev).toBeUndefined();
  });

  it("keeps the stable release bump workflow tag-only (no version commit onto master)", () => {
    const workflow = readFileSync(resolve(ROOT, ".github/workflows/bump-electron.yml"), "utf-8");
    // Tag-only contract: bump must NOT commit a version bump or push master.
    // A version-bump commit on master can't FF back to an always-ahead dev,
    // which kept breaking promote and regressed package.json on the next
    // dev→master reconcile. Version ships from the tag (release.yml
    // extraMetadata.version), mirroring bump-electron-beta.yml.
    expect(workflow).not.toContain('git commit -m "chore: bump version');
    expect(workflow).not.toContain("git push origin master");
    expect(workflow).not.toContain("Sync bump commit back to dev");
    // It must still create and push the release tag.
    expect(workflow).toContain('git tag -a "$NEW_TAG"');
    expect(workflow).toContain('git push origin "$NEW_TAG"');
  });

  it("keeps release-note workflow fixes from triggering app releases", () => {
    const stableWorkflow = readFileSync(resolve(ROOT, ".github/workflows/bump-electron.yml"), "utf-8");
    const betaWorkflow = readFileSync(resolve(ROOT, ".github/workflows/bump-electron-beta.yml"), "utf-8");

    expect(stableWorkflow).toContain("SKIP_RELEASE_PATTERN=");
    expect(stableWorkflow).toContain("fix: generate stable notes from dev promotion history");
    expect(stableWorkflow).toContain("grep -cvE \"$SKIP_RELEASE_PATTERN\"");

    expect(betaWorkflow).toContain("SKIP_RELEASE_PATTERN=");
    expect(betaWorkflow).toContain("fix: generate stable notes from dev promotion history");
    expect(betaWorkflow).toContain("grep -cvE \"$SKIP_RELEASE_PATTERN\"");
  });

  it("requires runtime file changes before bumping release channels", () => {
    const stableWorkflow = readFileSync(resolve(ROOT, ".github/workflows/bump-electron.yml"), "utf-8");
    const betaWorkflow = readFileSync(resolve(ROOT, ".github/workflows/bump-electron-beta.yml"), "utf-8");

    for (const workflow of [stableWorkflow, betaWorkflow]) {
      expect(workflow).toContain("RUNTIME_CHANGED_FILES=");
      expect(workflow).toContain("git diff --name-only");
      expect(workflow).toContain(":(exclude).github/**");
      expect(workflow).toContain(":(exclude)tests/**");
      expect(workflow).toContain(":(exclude)README.md");
      expect(workflow).toContain("No runtime files changed");
    }
  });

  it("enforces package/update boundary guards in GitHub Actions", () => {
    const workflowPath = resolve(ROOT, ".github/workflows/ci-quality.yml");
    expect(existsSync(workflowPath)).toBe(true);
    const workflow = readFileSync(workflowPath, "utf-8");
    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("push:");
    expect(workflow).toContain("branches: [dev, master]");
    expect(workflow).toContain("npm ci");
    expect(workflow).toContain("tests/unit/ci/package-boundary.test.ts");
    expect(workflow).toContain("tests/unit/update-scripts-path.test.ts");
    expect(workflow).toContain("tests/unit/update-checker.test.ts");
    expect(workflow).toContain("npm run typecheck:scripts");

    const promote = readFileSync(resolve(ROOT, ".github/workflows/promote-dev-to-master.yml"), "utf-8");
    expect(promote).toContain('if [ "$STATUS" = "green" ]; then');
    expect(promote).not.toContain("no-checks");
  });

  it("keeps public update scripts under strict TypeScript coverage", () => {
    const tsconfigPath = resolve(ROOT, "tsconfig.scripts.json");
    expect(existsSync(tsconfigPath)).toBe(true);
    const tsconfig = readJsonRecord(tsconfigPath);
    const compilerOptions = requireRecord(tsconfig, "compilerOptions");
    expect(compilerOptions.noEmit).toBe(true);
    expect(compilerOptions.rootDir).toBe(".");
    expect(requireStringArray(tsconfig, "include")).toEqual([
      "scripts/build/**/*.d.ts",
      "scripts/build/**/*.ts",
    ]);
  });

  it("keeps lockfile tarball sources on the official npm registry", () => {
    const disallowedSources = LOCKFILE_PATHS.flatMap((lockfilePath) =>
      collectNonNpmRegistrySources(lockfilePath),
    );
    expect(disallowedSources).toEqual([]);
  });

  it("rejects accidental Codex Desktop Electron package scripts at the proxy root", () => {
    for (const [name, command] of Object.entries(scripts)) {
      expect(command, `script ${name} should be a string`).toEqual(expect.any(String));
      const text = command as string;
      expect(text).not.toContain("electron-forge");
      expect(text).not.toContain("pnpm");
    }
    expect(scripts["forge:make"]).toBeUndefined();
    expect(scripts["rebuild:native-modules"]).toBeUndefined();
  });
});
