/**
 * Tests for the config-seed block shared by docker-entrypoint.sh and
 * scripts/docker/lite-entrypoint.sh (#837).
 *
 * Strategy: extract the block between the `config-seed` markers from each real
 * entrypoint and run it under `sh` with the path overrides pointed at temp
 * directories — no Docker, /defaults, chown or gosu needed. Running the same
 * cases against both entrypoints also catches drift between them.
 */

import { describe, it, expect, afterAll } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";

const ENTRYPOINTS = [
  "docker-entrypoint.sh",
  "scripts/docker/lite-entrypoint.sh",
];

const tmpBase = mkdtempSync(join(tmpdir(), "entrypoint-seed-"));

/**
 * A shell that can actually run a script file. The plain `sh -c exit 0` probe
 * used by other entrypoint tests is not enough on Windows, where `sh` may be
 * resolvable but unusable — these tests need real script execution.
 */
function findShell(): string | null {
  const probe = join(tmpBase, "probe.sh");
  writeFileSync(probe, "#!/bin/sh\necho ok\n");
  for (const candidate of ["/bin/sh", "/usr/bin/sh", "sh"]) {
    if (candidate.includes("/") && !existsSync(candidate)) continue;
    try {
      const out = execFileSync(candidate, [probe], { encoding: "utf-8", timeout: 5000 }).trim();
      if (out === "ok") return candidate;
    } catch {
      // try next candidate
    }
  }
  return null;
}

const shell = findShell();
const describeIfShell = shell ? describe : describe.skip;

function extractSeedBlock(file: string): string {
  const source = readFileSync(file, "utf8");
  const match = source.match(/# >>> config-seed\r?\n([\s\S]*?)# <<< config-seed/);
  if (!match) throw new Error(`config-seed block not found in ${file}`);
  return match[1];
}

interface SeedFixture {
  defaultsDir: string;
  configDir: string;
}

function makeFixture(options: {
  defaults: Record<string, string>;
  config: Record<string, string>;
  configDirExists?: boolean;
}): SeedFixture {
  const root = mkdtempSync(join(tmpBase, "case-"));
  const defaultsDir = join(root, "defaults");
  const configDir = join(root, "config");
  mkdirSync(defaultsDir, { recursive: true });
  if (options.configDirExists !== false) mkdirSync(configDir, { recursive: true });
  for (const [rel, content] of Object.entries(options.defaults)) {
    const target = join(defaultsDir, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  for (const [rel, content] of Object.entries(options.config)) {
    const target = join(configDir, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return { defaultsDir, configDir };
}

function runSeedBlock(entrypoint: string, fixture: SeedFixture): string {
  if (!shell) throw new Error("sh is not available");
  const scriptPath = join(tmpBase, `seed-block-${entrypoint.replace(/[\\/]/g, "_")}.sh`);
  // `set -e` mirrors the entrypoints' own shell options, so a block that would
  // abort the real entrypoint on a no-op or a failure also fails here.
  writeFileSync(scriptPath, `#!/bin/sh\nset -e\n${extractSeedBlock(entrypoint)}\n`);
  const result = spawnSync(shell, [scriptPath], {
    env: {
      ...process.env,
      CODEX_ENTRYPOINT_DEFAULTS_DIR: fixture.defaultsDir,
      CODEX_ENTRYPOINT_CONFIG_DIR: fixture.configDir,
    },
    encoding: "utf-8",
    timeout: 5000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`seed block exited ${result.status}: ${result.stderr ?? ""}`);
  }
  // Warnings go to stderr; return both streams so assertions can see them.
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

afterAll(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

describeIfShell.each(ENTRYPOINTS)("config seeding in %s", (entrypoint) => {
  it("seeds files missing from an existing volume and preserves user-edited files", () => {
    const fixture = makeFixture({
      defaults: {
        "default.yaml": "image: default\n",
        "model-pricing.yaml": "models: {}\n",
        "prompts/p.md": "new prompt\n",
      },
      config: {
        "default.yaml": "user-edited: true\n",
        "prompts/old.md": "old prompt\n",
      },
    });

    const out = runSeedBlock(entrypoint, fixture);

    // A file the newer image added reaches the existing volume...
    expect(readFileSync(join(fixture.configDir, "model-pricing.yaml"), "utf8")).toBe("models: {}\n");
    // ...nested new files are picked up as well...
    expect(readFileSync(join(fixture.configDir, "prompts", "p.md"), "utf8")).toBe("new prompt\n");
    // ...while existing files stay untouched, whether user-edited or an older default.
    expect(readFileSync(join(fixture.configDir, "default.yaml"), "utf8")).toBe("user-edited: true\n");
    expect(readFileSync(join(fixture.configDir, "prompts", "old.md"), "utf8")).toBe("old prompt\n");
    expect(out).toContain("2 missing file(s) seeded");
  });

  it("keeps root-level files in the config root after a nested directory", () => {
    const fixture = makeFixture({
      // The sorted directory is visited before the root-level file.
      defaults: {
        "a-prompts/p.md": "nested prompt\n",
        "z-default.yaml": "root default\n",
      },
      config: {},
    });

    runSeedBlock(entrypoint, fixture);

    expect(readFileSync(join(fixture.configDir, "z-default.yaml"), "utf8")).toBe("root default\n");
    expect(readFileSync(join(fixture.configDir, "a-prompts", "p.md"), "utf8")).toBe("nested prompt\n");
    expect(existsSync(join(fixture.configDir, "a-prompts", "z-default.yaml"))).toBe(false);
  });

  it("seeds a fully empty volume", () => {
    const fixture = makeFixture({
      defaults: { "default.yaml": "d\n", "model-pricing.yaml": "p\n" },
      config: {},
    });

    const out = runSeedBlock(entrypoint, fixture);

    expect(readFileSync(join(fixture.configDir, "default.yaml"), "utf8")).toBe("d\n");
    expect(readFileSync(join(fixture.configDir, "model-pricing.yaml"), "utf8")).toBe("p\n");
    expect(out).toContain("2 missing file(s) seeded");
  });

  it("creates the config directory when the mount target does not exist", () => {
    const fixture = makeFixture({
      defaults: { "default.yaml": "d\n" },
      config: {},
      configDirExists: false,
    });

    runSeedBlock(entrypoint, fixture);

    expect(readFileSync(join(fixture.configDir, "default.yaml"), "utf8")).toBe("d\n");
  });

  it("is a no-op when the image defaults are absent", () => {
    const fixture = makeFixture({
      defaults: {},
      config: { "default.yaml": "user\n" },
    });
    rmSync(fixture.defaultsDir, { recursive: true, force: true });

    const out = runSeedBlock(entrypoint, fixture);

    expect(out).toBe("");
    expect(readFileSync(join(fixture.configDir, "default.yaml"), "utf8")).toBe("user\n");
  });

  it("stays quiet when the volume already has every default file", () => {
    const fixture = makeFixture({
      defaults: {
        "default.yaml": "image: default\n",
        "model-pricing.yaml": "models: {}\n",
        "prompts/p.md": "new prompt\n",
      },
      config: {
        "default.yaml": "user-edited: true\n",
        "model-pricing.yaml": "models: {}\n",
        "prompts/p.md": "new prompt\n",
      },
    });

    const out = runSeedBlock(entrypoint, fixture);

    // Tooling reads this container's stdout (the image smoke test parses a
    // version out of it), so a no-op start must not print anything.
    expect(out).toBe("");
    expect(readFileSync(join(fixture.configDir, "default.yaml"), "utf8")).toBe("user-edited: true\n");
  });

  it("warns instead of failing when the config volume cannot be created", () => {
    const fixture = makeFixture({
      defaults: { "default.yaml": "d\n" },
      config: {},
    });
    // A regular file where the config directory should be: `mkdir -p` fails the
    // same way on every platform, unlike directory permissions.
    const blockedRoot = mkdtempSync(join(tmpBase, "blocked-"));
    const blockerFile = join(blockedRoot, "config-as-a-file");
    writeFileSync(blockerFile, "file\n");
    fixture.configDir = blockerFile;

    const out = runSeedBlock(entrypoint, fixture);

    expect(out).toContain("WARNING");
    expect(readFileSync(blockerFile, "utf8")).toBe("file\n");
  });
});
