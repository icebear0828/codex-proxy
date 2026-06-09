#!/usr/bin/env node
// Turns a raw "- type(scope): subject" commit list (stdin) into bilingual,
// user-facing release notes via one OpenAI-compatible chat completion call.
//
// Env: RELEASE_NOTES_BASE_URL (e.g. https://host/v1), RELEASE_NOTES_API_KEY,
//      RELEASE_NOTES_MODEL. Missing config or any LLM/validation failure falls
//      back to a grouped plain-English commit list — this script never exits
//      non-zero, so a notes problem can never block a release.
import fs from "fs";
import { fileURLToPath } from "url";

const CJK_RE = /[一-鿿]/;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_HIGHLIGHTS = 10;
const CHANGELOG_CONTEXT_CHARS = 8000;

export function buildPrompt(tag, commits, changelogExcerpt) {
  const changelogSection = changelogExcerpt
    ? `\n\nBackground from the project CHANGELOG (use only entries matching the commits above; it may describe unrelated work):\n${changelogExcerpt}`
    : "";
  return `You are writing GitHub release notes for ${tag} of Codex Proxy, a desktop app (Electron) that lets users connect coding clients to their ChatGPT account. The audience is END USERS of the desktop app — not developers of this repo.

Commits in this release:
${commits.join("\n")}${changelogSection}

Write 3-8 highlight bullets describing what users will actually notice: new features, fixed problems (describe the symptom users experienced, not internal code details), and anything they should be aware of. Merge related commits into one bullet. Skip pure refactors, tests, and CI changes. Do not mention file names, internal module names, or commit-type prefixes.

Respond with ONLY this JSON object, no other text:
{"highlights_zh": ["3-8 bullets in natural Chinese"], "highlights_en": ["the same bullets in natural English, same order"]}`;
}

export function parseHighlights(raw) {
  if (typeof raw !== "string") return null;
  const unfenced = raw.replace(/```(?:json)?/gi, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let parsed;
  try {
    parsed = JSON.parse(unfenced.slice(start, end + 1));
  } catch {
    return null;
  }
  const zh = parsed?.highlights_zh;
  const en = parsed?.highlights_en;
  // Single-line + length-capped: commit subjects reach the LLM verbatim, so a
  // prompt-injected response must not be able to smuggle extra markdown
  // structure (headings, fake sections) into the published notes.
  const isStringList = (v) =>
    Array.isArray(v) &&
    v.length > 0 &&
    v.length <= MAX_HIGHLIGHTS &&
    v.every((s) => typeof s === "string" && s.trim() !== "" && !s.includes("\n") && s.length <= 300);
  if (!isStringList(zh) || !isStringList(en)) return null;
  if (!CJK_RE.test(zh.join(""))) return null;
  return { zh, en };
}

// A commit subject containing literal HTML (e.g. "</details>") must not be
// able to break out of the details block in the published release body.
function escapeHtml(line) {
  return line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderNotes(highlights, commitLines) {
  const zh = highlights.zh.map((s) => `- ${s.trim()}`).join("\n");
  const en = highlights.en.map((s) => `- ${s.trim()}`).join("\n");
  return [
    "## ✨ 本次更新",
    "",
    zh,
    "",
    "## What's New",
    "",
    en,
    "",
    "<details>",
    "<summary>完整提交记录 / Full commit list</summary>",
    "",
    commitLines.map(escapeHtml).join("\n"),
    "",
    "</details>",
  ].join("\n");
}

const TYPE_GROUPS = [
  ["feat", "### Features"],
  ["fix", "### Fixes"],
  ["perf", "### Performance"],
];

export function renderFallback(commitLines) {
  const groups = new Map(TYPE_GROUPS.map(([, title]) => [title, []]));
  const other = [];
  for (const line of commitLines) {
    const subject = line.replace(/^- /, "");
    const match = subject.match(/^([a-z]+)(?:\([^)]*\))?!?:\s*(.*)$/i);
    const entry = `- ${match ? match[2] : subject}`;
    const group = match ? TYPE_GROUPS.find(([type]) => type === match[1].toLowerCase()) : undefined;
    if (group) {
      groups.get(group[1]).push(entry);
    } else {
      other.push(entry);
    }
  }
  const sections = [];
  for (const [, title] of TYPE_GROUPS) {
    const entries = groups.get(title);
    if (entries.length > 0) sections.push(`${title}\n\n${entries.join("\n")}`);
  }
  if (other.length > 0) sections.push(`### Other\n\n${other.join("\n")}`);
  return sections.join("\n\n");
}

export async function callLLM({ baseUrl, apiKey, model, prompt, fetchImpl = fetch }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`LLM endpoint returned ${response.status}`);
    const data = await response.json();
    return data?.choices?.[0]?.message?.content ?? null;
  } finally {
    clearTimeout(timer);
  }
}

function readChangelogExcerpt() {
  try {
    return fs.readFileSync("CHANGELOG.md", "utf-8").slice(0, CHANGELOG_CONTEXT_CHARS);
  } catch {
    return "";
  }
}

export async function generateNotes({ tag, input, env, fetchImpl = fetch, changelogExcerpt = "" }) {
  const lines = input.split("\n").filter((l) => l.trim() !== "");
  const commitLines = lines.filter((l) => l.startsWith("- "));
  if (commitLines.length === 0) {
    // "Initial release" / "Bug fixes and improvements" style passthrough
    return input.trim();
  }

  const baseUrl = env.RELEASE_NOTES_BASE_URL?.trim();
  const apiKey = env.RELEASE_NOTES_API_KEY?.trim();
  const model = env.RELEASE_NOTES_MODEL?.trim();
  if (baseUrl && apiKey && model) {
    const prompt = buildPrompt(tag, commitLines, changelogExcerpt);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await callLLM({ baseUrl, apiKey, model, prompt, fetchImpl });
        const highlights = parseHighlights(raw);
        if (highlights) return renderNotes(highlights, commitLines);
        console.error(`[release-notes] attempt ${attempt + 1}: LLM output failed validation`);
      } catch (error) {
        console.error(`[release-notes] attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`);
      }
    }
    console.error("[release-notes] falling back to grouped English commit list");
  } else {
    console.error("[release-notes] LLM env not configured, using grouped English commit list");
  }
  return renderFallback(commitLines);
}

function isMainModule() {
  try {
    return Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  // Read stdin exactly once: fd 0 is at EOF after the first read, so the
  // fatal fallback below must reuse this capture instead of re-reading.
  let capturedInput = "";
  try {
    capturedInput = fs.readFileSync(0, "utf-8");
  } catch {
    capturedInput = "";
  }
  const tag = process.argv[2] ?? "unreleased";
  generateNotes({
    tag,
    input: capturedInput,
    env: process.env,
    changelogExcerpt: readChangelogExcerpt(),
  })
    .then((notes) => console.log(notes))
    .catch((error) => {
      // Last-resort guard: emit the captured input rather than blocking the release.
      console.error(`[release-notes] fatal: ${error instanceof Error ? error.message : error}`);
      console.log(capturedInput.trim() || "Bug fixes and improvements");
    });
}
