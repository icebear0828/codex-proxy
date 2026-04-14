/**
 * Unit tests for Docker registry version check.
 *
 * Verifies that Docker mode queries GHCR for the latest published image tag
 * instead of relying on GitHub Releases API.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { checkDockerRegistryVersion } from "@src/self-update.js";

// ── Helpers ──────────────────────────────────────────────────────────

const GHCR_TOKEN_URL = "https://ghcr.io/token?service=ghcr.io&scope=repository:icebear0828/codex-proxy:pull";
const GHCR_TAGS_URL = "https://ghcr.io/v2/icebear0828/codex-proxy/tags/list";

function mockFetchSequence(...responses: Array<{ ok: boolean; json: () => Promise<unknown> }>): void {
  const fn = vi.fn() as ReturnType<typeof vi.fn>;
  for (const resp of responses) {
    fn.mockResolvedValueOnce(resp);
  }
  vi.stubGlobal("fetch", fn);
}

function tokenResponse(token = "test-token") {
  return { ok: true, json: async () => ({ token }) };
}

function tagsResponse(tags: string[]) {
  return {
    ok: true,
    json: async () => ({ name: "icebear0828/codex-proxy", tags }),
    headers: new Headers(),
  };
}

function failResponse(status = 401) {
  return { ok: false, json: async () => ({ errors: [{ message: `HTTP ${status}` }] }) };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("checkDockerRegistryVersion", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the highest semver tag from GHCR", async () => {
    mockFetchSequence(
      tokenResponse(),
      tagsResponse(["latest", "v2.0.40", "v2.0.42", "v2.0.41"]),
    );

    const version = await checkDockerRegistryVersion();
    expect(version).toBe("2.0.42");
  });

  it("ignores non-version tags", async () => {
    mockFetchSequence(
      tokenResponse(),
      tagsResponse(["latest", "sha-abc1234", "dev", "v1.5.0"]),
    );

    const version = await checkDockerRegistryVersion();
    expect(version).toBe("1.5.0");
  });

  it("returns null when no version tags exist", async () => {
    mockFetchSequence(
      tokenResponse(),
      tagsResponse(["latest", "dev"]),
    );

    const version = await checkDockerRegistryVersion();
    expect(version).toBeNull();
  });

  it("returns null when token request fails", async () => {
    mockFetchSequence(failResponse(403));

    const version = await checkDockerRegistryVersion();
    expect(version).toBeNull();
  });

  it("returns null when tags request fails", async () => {
    mockFetchSequence(
      tokenResponse(),
      failResponse(401),
    );

    const version = await checkDockerRegistryVersion();
    expect(version).toBeNull();
  });

  it("returns null on network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const version = await checkDockerRegistryVersion();
    expect(version).toBeNull();
  });

  it("calls correct GHCR endpoints with bearer token", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokenResponse("my-token"))
      .mockResolvedValueOnce(tagsResponse(["v1.0.0"]));
    vi.stubGlobal("fetch", fetchMock);

    await checkDockerRegistryVersion();

    expect(fetchMock).toHaveBeenCalledTimes(2);

    // First call: token endpoint
    const [tokenUrl, tokenOpts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(tokenUrl).toBe(GHCR_TOKEN_URL);

    // Second call: tags endpoint with bearer token
    const [tagsUrl, tagsOpts] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(tagsUrl).toBe(GHCR_TAGS_URL);
    expect((tagsOpts.headers as Record<string, string>)["Authorization"]).toBe("Bearer my-token");
  });

  it("follows OCI pagination via Link header", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      // Page 1: returns Link header for next page
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ name: "icebear0828/codex-proxy", tags: ["v1.0.0", "v1.0.1"] }),
        headers: new Headers({
          link: '</v2/icebear0828/codex-proxy/tags/list?last=v1.0.1>; rel="next"',
        }),
      })
      // Page 2: no Link header (last page)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ name: "icebear0828/codex-proxy", tags: ["v2.0.0", "latest"] }),
        headers: new Headers(),
      });
    vi.stubGlobal("fetch", fetchMock);

    const version = await checkDockerRegistryVersion();
    expect(version).toBe("2.0.0");
    // 3 fetch calls: token + page 1 + page 2
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("handles tags with various v-prefix formats", async () => {
    mockFetchSequence(
      tokenResponse(),
      tagsResponse(["v2.0.44", "2.0.43", "v2.0.45"]),
    );

    // Both "v2.0.45" and "2.0.43" should be parsed, highest wins
    const version = await checkDockerRegistryVersion();
    expect(version).toBe("2.0.45");
  });
});
