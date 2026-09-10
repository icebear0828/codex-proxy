import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..", "..", "..");
const WORKFLOW_DIR = resolve(ROOT, ".github", "workflows");
const DOCKERFILE = resolve(ROOT, "Dockerfile");
const LITE_DOCKERFILE = resolve(ROOT, "Dockerfile.lite");

type OutputRef = { stepId: string; output: string };
type Step = { id?: string; run?: string; uses?: string; with?: Record<string, unknown> };

function loadWorkflow(name: string) {
  const yaml = require("js-yaml") as typeof import("js-yaml");
  return yaml.load(readFileSync(resolve(WORKFLOW_DIR, name), "utf-8")) as {
    jobs: Record<string, { steps: Step[] }>;
  };
}

/**
 * Extract steps.X.outputs.Y references from a step's run script or `with`.
 * GitHub Actions interpolates ${{ steps.<id>.outputs.<name> }} anywhere in a
 * composite value, so scan raw text rather than parsing structure.
 */
function collectOutputRefs(value: unknown): OutputRef[] {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  const refs: OutputRef[] = [];
  const pattern = /\$\{\{\s*steps\.([A-Za-z_][\w-]*)\.outputs\.([\w-]+)\s*\}\}/g;
  for (const match of text.matchAll(pattern)) {
    refs.push({ stepId: match[1], output: match[2] });
  }
  return refs;
}

/**
 * v2.1.0–v2.1.6 Docker images shipped with a stale version display
 * (issue #794): #673 deleted the "Resolve version" step that produced
 * `outputs.version`, while #677 still passed
 * `PROXY_VERSION=${{ steps.version.outputs.version }}` to docker build —
 * an empty value, so containers silently fell back to package.json.
 * Guard every workflow against dangling steps.*.outputs.* references.
 */
describe("workflow output references are satisfied", () => {
  const workflowFiles = [
    "docker-publish.yml",
    "bump-electron.yml",
    "bump-electron-beta.yml",
    "release.yml",
    "promote-dev-to-master.yml",
    "lite-ci.yml",
    "ci-docker.yml",
  ];

  for (const file of workflowFiles) {
    it(`${file}: every referenced step output is produced by an earlier step`, () => {
      const workflow = loadWorkflow(file);
      const producers = new Map<string, Set<string>>();
      const consumers: { job: string; stepIndex: number; refs: OutputRef[] }[] = [];

      for (const [jobName, job] of Object.entries(workflow.jobs)) {
        for (const [stepIndex, step] of (job.steps ?? []).entries()) {
          const refs = [
            ...collectOutputRefs(step.run),
            ...collectOutputRefs(step.with),
          ];
          if (refs.length > 0) consumers.push({ job: jobName, stepIndex, refs });

          // A step both producing and consuming outputs (inline scripts
          // writing to GITHUB_OUTPUT) is legal; record its declared id
          // for later consumers only after collecting its references.
          if (step.id) {
            if (!producers.has(step.id)) producers.set(step.id, new Set());
            producers.get(step.id)!.add("__declared__");
          }
        }
      }

      for (const { job, stepIndex, refs } of consumers) {
        for (const ref of refs) {
          const produced = producers.get(ref.stepId);
          // The step must be declared somewhere in the workflow. We cannot
          // statically prove which GITHUB_OUTPUT keys a script writes, so a
          // declared step satisfies any output — but a reference to a
          // NEVER-declared step id (the #794 failure mode) must fail.
          expect(
            produced,
            `${file}: job "${job}" step #${stepIndex} references ` +
              `steps.${ref.stepId}.outputs.${ref.output}, but no step with id ` +
              `"${ref.stepId}" exists (dangling output reference — version ` +
              `display regression #794 class)`,
          ).toBeDefined();
        }
      }
    });
  }

  it("docker-publish bakes a non-empty PROXY_VERSION into the image", () => {
    const workflow = loadWorkflow("docker-publish.yml");
    const versionStep = workflow.jobs.publish.steps.find((s) => s.id === "version");
    expect(versionStep).toBeDefined();
    // Both selection branches must write a version output: tag dispatch
    // (echo "version=${TAG_INPUT#v}") and branch push (max of package.json
    // and newest stable tag).
    expect(versionStep!.run).toContain('echo "version=${TAG_INPUT#v}"');
    expect(versionStep!.run).toContain('echo "version=$FINAL"');

    const buildStep = workflow.jobs.publish.steps.find(
      (s) => s.uses === "docker/build-push-action@v6",
    );
    expect(buildStep!.with?.["build-args"]).toContain("PROXY_VERSION=");
    // Checkout must fetch tags so branch pushes can read stable tags.
    const checkout = workflow.jobs.publish.steps.find(
      (s) => s.uses === "actions/checkout@v4",
    );
    expect(checkout!.with?.["fetch-tags"]).toBe(true);

    const dockerfile = readFileSync(DOCKERFILE, "utf8");
    expect(dockerfile).toContain('sync-package-version.mjs "$PROXY_VERSION"');
  });

  it("docker smoke test rejects version metadata drift", () => {
    const ciDocker = readFileSync(resolve(WORKFLOW_DIR, "ci-docker.yml"), "utf8");
    expect(ciDocker).toContain("SMOKE_VERSION=99.99.99");
    expect(ciDocker).toContain("PACKAGE_VER=$(docker run --rm codex-proxy:smoke");
    expect(ciDocker).toContain("Docker version mismatch");
  });

  it("docker-publish-lite shares the resolved version across the manifest and image", () => {
    const workflow = loadWorkflow("docker-publish.yml");
    const job = workflow.jobs["publish-lite"];
    const versionStep = job.steps.find((s) => s.id === "version");
    expect(versionStep).toBeDefined();
    expect(versionStep!.run).toContain('echo "version=${TAG_INPUT#v}"');
    expect(versionStep!.run).toContain('echo "version=$FINAL"');
    expect(versionStep!.run).toContain("LATEST_STABLE=");
    expect(versionStep!.run).toContain("git tag --sort=-v:refname");

    const checkout = job.steps.find((s) => s.uses === "actions/checkout@v4");
    expect(checkout!.with?.["fetch-tags"]).toBe(true);
    expect(checkout!.with?.["fetch-depth"]).toBe(0);

    const stageStep = job.steps.find((s) => s.id === undefined && s.run?.includes("build-portable.mjs"));
    expect(stageStep?.run).toContain('--version "${{ steps.version.outputs.version }}"');

    const buildStep = job.steps.find(
      (s) => s.uses === "docker/build-push-action@v6",
    );
    expect(buildStep!.with?.["build-args"]).toContain("PROXY_VERSION=${{ steps.version.outputs.version }}");

    const dockerfile = readFileSync(LITE_DOCKERFILE, "utf8");
    expect(dockerfile).toContain("ARG PROXY_VERSION=unknown");
    expect(dockerfile).toContain("PROXY_VERSION=${PROXY_VERSION}");
  });

  it("docker-publish-lite executes smoke test before pushing the image to registry", () => {
    const workflow = loadWorkflow("docker-publish.yml");
    const job = workflow.jobs["publish-lite"];
    const pushStepIndex = job.steps.findIndex(
      (s) => s.uses === "docker/build-push-action@v6" && s.with?.push === true,
    );
    expect(pushStepIndex, "push step must exist").toBeGreaterThanOrEqual(0);

    const smokeStepIndex = job.steps.findIndex(
      (s) => s.name?.toLowerCase().includes("smoke test") && s.name?.toLowerCase().includes("image"),
    );
    expect(smokeStepIndex, "image smoke test step must exist").toBeGreaterThanOrEqual(0);
    expect(
      smokeStepIndex,
      "smoke test must execute before pushing to prevent shipping a broken image",
    ).toBeLessThan(pushStepIndex);
  });
});

