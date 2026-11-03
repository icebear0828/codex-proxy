import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  OfficialCatalogSync,
  toBackendModelEntries,
  type OfficialCatalogSyncOptions,
} from "@src/models/official-model-catalog.js";

const tempDirs: string[] = [];

function makeCachePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "official-catalog-"));
  tempDirs.push(dir);
  return join(dir, "official-model-catalog.json");
}

function makeSync(options: OfficialCatalogSyncOptions = {}): {
  sync: OfficialCatalogSync;
  cacheFile: string;
} {
  const cacheFile = options.cacheFile ?? makeCachePath();
  const sync = new OfficialCatalogSync({ ...options, cacheFile });
  return { sync, cacheFile };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function modelEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: "gpt-6.1-sol",
    display_name: "GPT-6.1 Sol",
    description: "Frontier workhorse.",
    context_window: 1_000_000,
    max_context_window: 1_200_000,
    max_output_tokens: 128_000,
    auto_compact_token_limit: 900_000,
    default_reasoning_level: "medium",
    supported_reasoning_levels: [
      { effort: "low", description: "Fast" },
      { effort: "high", description: "Deep" },
    ],
    input_modalities: ["text", "image"],
    output_modalities: ["text"],
    visibility: "list",
    supported_in_api: true,
    priority: 1,
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("OfficialCatalogSync", () => {
  it("maps the official manifest, filters hidden/unsupported models, and writes the cache", async () => {
    const fetchFn = (async () => jsonResponse({
      models: [
        modelEntry(),
        modelEntry({
          slug: "gpt-6.1-terra",
          display_name: "GPT-6.1 Terra",
          description: "Coding model.",
          priority: 2,
        }),
        modelEntry({ slug: "daybreak", visibility: "hide" }),
        modelEntry({ slug: "not-served", supported_in_api: false }),
      ],
    })) as unknown as typeof fetch;

    const { sync, cacheFile } = makeSync({
      fetchFn,
      now: () => new Date("2026-11-03T00:00:00.000Z"),
    });
    const snapshot = await sync.fetchAndSave();

    expect(snapshot).not.toBeNull();
    expect(snapshot!.models.map((m) => m.id)).toEqual(["gpt-6.1-sol", "gpt-6.1-terra"]);
    expect(snapshot!.fetchedAt).toBe("2026-11-03T00:00:00.000Z");
    expect(snapshot!.sourceUrl).toBe(
      "https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json",
    );

    const sol = snapshot!.models[0];
    expect(sol).toMatchObject({
      id: "gpt-6.1-sol",
      displayName: "GPT-6.1 Sol",
      description: "Frontier workhorse.",
      contextWindow: 1_000_000,
      maxContextWindow: 1_200_000,
      maxOutputTokens: 128_000,
      autoCompactTokenLimit: 900_000,
      defaultReasoningEffort: "medium",
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
      visibility: "list",
      priority: 1,
      supportedInApi: true,
      supportsPersonality: false,
      upgrade: null,
      source: "static",
      isDefault: false,
    });
    expect(sol.supportedReasoningEfforts).toEqual([
      { reasoningEffort: "low", description: "Fast" },
      { reasoningEffort: "high", description: "Deep" },
    ]);

    expect(existsSync(cacheFile)).toBe(true);
    const cached = JSON.parse(readFileSync(cacheFile, "utf-8"));
    expect(cached.models).toHaveLength(2);
    expect(sync.getSnapshot()).toEqual(snapshot);
    expect(sync.getModels().map((m) => m.id)).toEqual(["gpt-6.1-sol", "gpt-6.1-terra"]);
  });

  it("returns null and writes nothing on a non-2xx response", async () => {
    const fetchFn = (async () => jsonResponse({ models: [modelEntry()] }, 500)) as unknown as typeof fetch;
    const { sync, cacheFile } = makeSync({ fetchFn });

    await expect(sync.fetchAndSave()).resolves.toBeNull();
    expect(existsSync(cacheFile)).toBe(false);
    expect(sync.getModels()).toEqual([]);
  });

  it("returns null for malformed structures", async () => {
    const notArray = (async () => jsonResponse({ models: "nope" })) as unknown as typeof fetch;
    const empty = (async () => jsonResponse({ models: [] })) as unknown as typeof fetch;

    const first = makeSync({ fetchFn: notArray });
    const second = makeSync({ fetchFn: empty });

    await expect(first.sync.fetchAndSave()).resolves.toBeNull();
    await expect(second.sync.fetchAndSave()).resolves.toBeNull();
    expect(existsSync(first.cacheFile)).toBe(false);
    expect(existsSync(second.cacheFile)).toBe(false);
  });

  it("returns null when the fetch times out", async () => {
    const fetchFn = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;

    const { sync, cacheFile } = makeSync({ fetchFn, timeoutMs: 20 });
    await expect(sync.fetchAndSave()).resolves.toBeNull();
    expect(existsSync(cacheFile)).toBe(false);
  });

  it("returns null from loadCached on corrupt JSON", () => {
    const cacheFile = makeCachePath();
    writeFileSync(cacheFile, "{ not json", "utf-8");
    const sync = new OfficialCatalogSync({ cacheFile });
    expect(sync.loadCached()).toBeNull();
    expect(sync.getSnapshot()).toBeNull();
  });

  it("deduplicates repeated slugs while keeping official order", async () => {
    const fetchFn = (async () => jsonResponse({
      models: [
        modelEntry({ slug: "gpt-6.1-sol" }),
        modelEntry({ slug: "gpt-6.1-terra", display_name: "GPT-6.1 Terra" }),
        modelEntry({ slug: "gpt-6.1-sol", display_name: "Duplicate Sol" }),
      ],
    })) as unknown as typeof fetch;
    const { sync } = makeSync({ fetchFn });

    const snapshot = await sync.fetchAndSave();
    expect(snapshot!.models.map((m) => m.id)).toEqual(["gpt-6.1-sol", "gpt-6.1-terra"]);
    expect(snapshot!.models[0].displayName).toBe("GPT-6.1 Sol");
  });

  it("treats a snapshot older than maxAgeMs as stale", async () => {
    let nowMs = Date.parse("2026-11-03T00:00:00.000Z");
    const fetchFn = (async () => jsonResponse({ models: [modelEntry()] })) as unknown as typeof fetch;
    const { sync } = makeSync({
      fetchFn,
      now: () => new Date(nowMs),
      maxAgeMs: 6 * 60 * 60 * 1000,
    });

    await sync.fetchAndSave();
    expect(sync.isStale()).toBe(false);
    expect(sync.getFreshSnapshot()).not.toBeNull();

    // 5h59m — still fresh.
    nowMs += (6 * 60 * 60 * 1000) - 60_000;
    expect(sync.isStale()).toBe(false);

    // 6h01m — stale, but the snapshot is still readable.
    nowMs += 2 * 60_000;
    expect(sync.isStale()).toBe(true);
    expect(sync.getFreshSnapshot()).toBeNull();
    expect(sync.getModels().map((m) => m.id)).toEqual(["gpt-6.1-sol"]);
  });

  it("marks a cached snapshot written without fetchedAt as stale", () => {
    const cacheFile = makeCachePath();
    writeFileSync(cacheFile, JSON.stringify({
      sourceUrl: "https://example.test/models.json",
      models: [{ id: "gpt-6.1-sol", displayName: "Sol" }],
    }), "utf-8");

    const sync = new OfficialCatalogSync({ cacheFile });
    expect(sync.getSnapshot()).not.toBeNull();
    expect(sync.isStale()).toBe(true);
    expect(sync.getFreshSnapshot()).toBeNull();
  });

  it("returns the cached snapshot without fetching while it is fresh", async () => {
    let fetchCalls = 0;
    const fetchFn = (async () => {
      fetchCalls++;
      return jsonResponse({ models: [modelEntry()] });
    }) as unknown as typeof fetch;
    const nowMs = Date.parse("2026-11-03T00:00:00.000Z");
    const { sync } = makeSync({ fetchFn, now: () => new Date(nowMs) });

    const first = await sync.refreshIfStale();
    expect(first?.models.map((m) => m.id)).toEqual(["gpt-6.1-sol"]);
    expect(fetchCalls).toBe(1);

    const second = await sync.refreshIfStale();
    expect(second?.models.map((m) => m.id)).toEqual(["gpt-6.1-sol"]);
    expect(fetchCalls).toBe(1);
  });

  it("refreshes a stale snapshot and keeps the previous one when the refresh fails", async () => {
    let nowMs = Date.parse("2026-11-03T00:00:00.000Z");
    let fail = false;
    let fetchCalls = 0;
    const fetchFn = (async () => {
      fetchCalls++;
      if (fail) return jsonResponse({ error: "boom" }, 503);
      return jsonResponse({ models: [modelEntry({ slug: "gpt-6.1-sol" })] });
    }) as unknown as typeof fetch;
    const { sync } = makeSync({
      fetchFn,
      now: () => new Date(nowMs),
      maxAgeMs: 60_000,
      retryAfterMs: 0,
    });

    await sync.fetchAndSave();
    nowMs += 61_000;
    expect(sync.isStale()).toBe(true);

    // Failed refresh: no new data, but the old snapshot survives.
    fail = true;
    const afterFailure = await sync.refreshIfStale();
    expect(fetchCalls).toBe(2);
    expect(afterFailure?.models.map((m) => m.id)).toEqual(["gpt-6.1-sol"]);
    expect(sync.getSnapshot()).not.toBeNull();

    // Recovery replaces the stale snapshot.
    fail = false;
    const refreshed = await sync.refreshIfStale();
    expect(fetchCalls).toBe(3);
    expect(refreshed?.fetchedAt).toBe(new Date(nowMs).toISOString());
    expect(sync.isStale()).toBe(false);
  });

  it("defers retries after a failure for retryAfterMs", async () => {
    let nowMs = Date.parse("2026-11-03T00:00:00.000Z");
    let fetchCalls = 0;
    const fetchFn = (async () => {
      fetchCalls++;
      return jsonResponse({ error: "boom" }, 503);
    }) as unknown as typeof fetch;
    const { sync } = makeSync({
      fetchFn,
      now: () => new Date(nowMs),
      retryAfterMs: 5 * 60 * 1000,
    });

    await expect(sync.refreshIfStale()).resolves.toBeNull();
    await expect(sync.refreshIfStale()).resolves.toBeNull();
    expect(fetchCalls).toBe(1);

    nowMs += 5 * 60 * 1000 + 1;
    await expect(sync.refreshIfStale()).resolves.toBeNull();
    expect(fetchCalls).toBe(2);
  });

  it("shares one in-flight refresh between concurrent callers", async () => {
    let fetchCalls = 0;
    let release: (() => void) | null = null;
    const fetchFn = (async () => {
      fetchCalls++;
      await new Promise<void>((resolve) => { release = resolve; });
      return jsonResponse({ models: [modelEntry()] });
    }) as unknown as typeof fetch;
    const { sync } = makeSync({ fetchFn });

    const first = sync.refreshIfStale();
    const second = sync.refreshIfStale();
    await Promise.resolve();
    expect(fetchCalls).toBe(1);
    release!();
    const [a, b] = await Promise.all([first, second]);
    expect(a?.models).toHaveLength(1);
    expect(b?.models).toHaveLength(1);
    expect(fetchCalls).toBe(1);
  });
});

describe("toBackendModelEntries", () => {
  it("maps every snapshot field back to the snake_case backend payload", async () => {
    const fetchFn = (async () => jsonResponse({ models: [modelEntry()] })) as unknown as typeof fetch;
    const { sync } = makeSync({ fetchFn });
    const snapshot = await sync.fetchAndSave();

    const [entry] = toBackendModelEntries(snapshot!.models);
    expect(entry).toEqual({
      slug: "gpt-6.1-sol",
      display_name: "GPT-6.1 Sol",
      description: "Frontier workhorse.",
      default_reasoning_level: "medium",
      supported_reasoning_levels: [
        { effort: "low", description: "Fast" },
        { effort: "high", description: "Deep" },
      ],
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
      supports_personality: false,
      upgrade: null,
      context_window: 1_000_000,
      max_context_window: 1_200_000,
      max_output_tokens: 128_000,
      auto_compact_token_limit: 900_000,
      visibility: "list",
      priority: 1,
      supported_in_api: true,
    });
  });
});
