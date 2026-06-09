import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { resolve } from "path";
import { beforeAll, describe, expect, it } from "vitest";

// Plain ESM script (no build step); vitest transforms it, tsc does not cover tests.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- untyped .mjs CI script
import { buildPrompt, generateNotes, parseHighlights, renderFallback } from "../../../.github/scripts/summarize-release-notes.mjs";

const ROOT = resolve(__dirname, "..", "..", "..");
const SCRIPT = resolve(ROOT, ".github", "scripts", "summarize-release-notes.mjs");

const COMMITS = [
  "- fix(ws): add connection timeout and abort handling in ws-transport",
  "- feat: dashboard credit balance visualization",
  "- fix: resolve ws response before codex.rate_limits bypass",
].join("\n");

const LLM_ENV = {
  RELEASE_NOTES_BASE_URL: "https://llm.example/v1",
  RELEASE_NOTES_API_KEY: "test-key",
  RELEASE_NOTES_MODEL: "test-model",
};

const VALID_LLM_JSON = JSON.stringify({
  highlights_zh: ["修复 WebSocket 连接超时导致的请求卡死", "新增账号额度余额可视化面板"],
  highlights_en: ["Fixed WebSocket timeouts hanging requests", "Added credit balance visualization"],
});

interface FetchStub {
  fetchImpl: typeof fetch;
  requests: { url: string; body: Record<string, unknown> }[];
}

function stubLLM(status: number, content: string): FetchStub {
  const requests: FetchStub["requests"] = [];
  const fetchImpl = (async (url: unknown, init?: { body?: unknown }) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ choices: [{ message: { role: "assistant", content } }] }),
    };
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

describe("summarize-release-notes generateNotes", () => {
  it("produces bilingual notes from a valid LLM response, with raw commits in details", async () => {
    const stub = stubLLM(200, VALID_LLM_JSON);
    const out = await generateNotes({ tag: "v9.9.9", input: COMMITS, env: LLM_ENV, fetchImpl: stub.fetchImpl });

    expect(out).toContain("## ✨ 本次更新");
    expect(out).toContain("修复 WebSocket 连接超时导致的请求卡死");
    expect(out).toContain("## What's New");
    expect(out).toContain("Fixed WebSocket timeouts hanging requests");
    expect(out).toContain("<details>");
    expect(out).toContain("fix(ws): add connection timeout and abort handling in ws-transport");

    expect(stub.requests[0].url).toBe("https://llm.example/v1/chat/completions");
    expect(stub.requests[0].body.model).toBe("test-model");
    const messages = stub.requests[0].body.messages as { content: string }[];
    expect(messages.some((m) => m.content.includes("ws-transport"))).toBe(true);
  });

  it("falls back to grouped English list when LLM env is not configured", async () => {
    const out = await generateNotes({ tag: "v9.9.9", input: COMMITS, env: {} });

    expect(out).toContain("connection timeout and abort handling");
    expect(out).toContain("dashboard credit balance visualization");
    // no dictionary word salad, no fake-Chinese headers
    expect(out).not.toContain("中文版 (翻译)");
    expect(out).not.toMatch(/[一-鿿]/);
    // grouped by type
    expect(out).toContain("### Fixes");
    expect(out).toContain("### Features");
  });

  it("falls back when the LLM returns non-JSON garbage", async () => {
    const stub = stubLLM(200, "Sure! Here are the notes you asked for.");
    const out = await generateNotes({ tag: "v9.9.9", input: COMMITS, env: LLM_ENV, fetchImpl: stub.fetchImpl });
    expect(out).toContain("### Fixes");
    expect(out).not.toContain("## ✨ 本次更新");
    // validation failure is retried once before falling back
    expect(stub.requests).toHaveLength(2);
  });

  it("falls back when the Chinese highlights contain no CJK", async () => {
    const stub = stubLLM(200, JSON.stringify({ highlights_zh: ["all english"], highlights_en: ["all english"] }));
    const out = await generateNotes({ tag: "v9.9.9", input: COMMITS, env: LLM_ENV, fetchImpl: stub.fetchImpl });
    expect(out).toContain("### Fixes");
  });

  it("falls back when the LLM endpoint errors", async () => {
    const stub = stubLLM(500, "{}");
    const out = await generateNotes({ tag: "v9.9.9", input: COMMITS, env: LLM_ENV, fetchImpl: stub.fetchImpl });
    expect(out).toContain("### Fixes");
  });

  it("accepts JSON wrapped in markdown fences", async () => {
    const stub = stubLLM(200, "```json\n" + VALID_LLM_JSON + "\n```");
    const out = await generateNotes({ tag: "v9.9.9", input: COMMITS, env: LLM_ENV, fetchImpl: stub.fetchImpl });
    expect(out).toContain("## ✨ 本次更新");
  });

  it("passes through non-commit single-line input (Initial release)", async () => {
    const out = await generateNotes({ tag: "v9.9.9", input: "Initial release", env: {} });
    expect(out).toBe("Initial release");
  });

  it("includes the changelog excerpt in the prompt when provided", () => {
    const prompt = buildPrompt("v1.0.0", ["- fix: a"], "## [Unreleased]\n- 修复某问题");
    expect(prompt).toContain("修复某问题");
    expect(prompt).toContain("highlights_zh");
  });
});

describe("summarize-release-notes parseHighlights", () => {
  it("rejects multi-line and oversized highlight items (markdown injection guard)", () => {
    expect(
      parseHighlights(JSON.stringify({ highlights_zh: ["修复\n## 假标题"], highlights_en: ["ok"] })),
    ).toBeNull();
    expect(
      parseHighlights(JSON.stringify({ highlights_zh: ["修" + "复".repeat(400)], highlights_en: ["ok"] })),
    ).toBeNull();
  });

  it("rejects empty, oversized, or non-string arrays", () => {
    expect(parseHighlights(JSON.stringify({ highlights_zh: [], highlights_en: ["x"] }))).toBeNull();
    expect(parseHighlights(JSON.stringify({ highlights_zh: ["中文", 42], highlights_en: ["x", "y"] }))).toBeNull();
    expect(
      parseHighlights(
        JSON.stringify({ highlights_zh: Array(20).fill("中文条目"), highlights_en: Array(20).fill("entry") }),
      ),
    ).toBeNull();
    expect(parseHighlights("not json at all")).toBeNull();
  });

  it("accepts a valid bilingual payload", () => {
    const parsed = parseHighlights(VALID_LLM_JSON);
    expect(parsed?.zh).toHaveLength(2);
    expect(parsed?.en).toHaveLength(2);
  });
});

describe("summarize-release-notes renderFallback", () => {
  it("groups commits by conventional type and strips prefixes", () => {
    const out = renderFallback(["- fix(ws): repair sockets", "- feat: shiny thing", "- perf: faster", "- 1.2.3 misc"]);
    expect(out).toContain("### Fixes\n\n- repair sockets");
    expect(out).toContain("### Features\n\n- shiny thing");
    expect(out).toContain("### Performance\n\n- faster");
    expect(out).toContain("### Other\n\n- 1.2.3 misc");
  });

  it("groups breaking-change commits (feat!:) under their type", () => {
    const out = renderFallback(["- feat!: breaking thing", "- fix(scope)!: breaking fix"]);
    expect(out).toContain("### Features\n\n- breaking thing");
    expect(out).toContain("### Fixes\n\n- breaking fix");
    expect(out).not.toContain("### Other");
  });
});

describe("summarize-release-notes renderNotes escaping", () => {
  it("neutralizes HTML in commit lines so </details> cannot break the block", async () => {
    const stub = stubLLM(200, VALID_LLM_JSON);
    const out = await generateNotes({
      tag: "v9.9.9",
      input: "- fix: close </details> tag <b>bold</b>",
      env: LLM_ENV,
      fetchImpl: stub.fetchImpl,
    });
    expect(out).not.toContain("close </details>");
    expect(out).toContain("&lt;/details&gt;");
    // exactly one real closing tag: the one renderNotes emits itself
    expect(out.match(/<\/details>/g)).toHaveLength(1);
  });
});

describe("summarize-release-notes.mjs CLI", () => {
  beforeAll(() => {
    expect(existsSync(SCRIPT), `script missing: ${SCRIPT}`).toBe(true);
  });

  function runScript(input: string): string {
    return execFileSync("node", [SCRIPT, "v9.9.9"], {
      encoding: "utf-8",
      input,
      env: { ...process.env, RELEASE_NOTES_BASE_URL: "", RELEASE_NOTES_API_KEY: "", RELEASE_NOTES_MODEL: "" },
      timeout: 15000,
    });
  }

  it("exits zero and emits grouped fallback without LLM env (release must not be blocked)", () => {
    const out = runScript(COMMITS);
    expect(out).toContain("### Fixes");
    expect(out).toContain("### Features");
  });

  it("passes through single-line input", () => {
    expect(runScript("Initial release").trim()).toBe("Initial release");
  });

  it("exits zero with fallback when the LLM endpoint is unreachable (real fetch path)", () => {
    // .invalid TLD resolves nowhere (RFC 2606) → fast DNS failure, both
    // retries fail, grouped fallback, exit 0. Pins the never-blocks-release
    // invariant through the exact subprocess mode release.yml uses.
    const out = execFileSync("node", [SCRIPT, "v9.9.9"], {
      encoding: "utf-8",
      input: COMMITS,
      env: {
        ...process.env,
        RELEASE_NOTES_BASE_URL: "http://release-notes-test.invalid/v1",
        RELEASE_NOTES_API_KEY: "k",
        RELEASE_NOTES_MODEL: "m",
      },
      timeout: 30000,
    });
    expect(out).toContain("### Fixes");
  });
});
