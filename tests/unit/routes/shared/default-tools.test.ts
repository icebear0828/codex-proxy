import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  resolveDefaultTools,
  mergeDefaultTools,
  normalizeHostedTool,
} from "../../../../src/routes/shared/default-tools.js";
import { loadConfig } from "../../../../src/config.js";
import type { ClientKeyEntry } from "../../../../src/auth/client-key-types.js";

describe("default-tools resolution and merging", () => {
  beforeEach(() => {
    loadConfig();
  });

  describe("normalizeHostedTool", () => {
    it("normalizes 'web_search' to { type: 'web_search' }", () => {
      expect(normalizeHostedTool("web_search")).toEqual({ type: "web_search" });
    });

    it("normalizes 'image_generation' to { type: 'image_generation' }", () => {
      expect(normalizeHostedTool("image_generation")).toEqual({ type: "image_generation" });
    });

    it("normalizes arbitrary hosted tool to { type: '<name>' }", () => {
      expect(normalizeHostedTool("code_interpreter")).toEqual({ type: "code_interpreter" });
    });
  });

  describe("mergeDefaultTools", () => {
    it("returns default tools array when existingTools is undefined or empty", () => {
      const merged = mergeDefaultTools(undefined, ["web_search"]);
      expect(merged).toEqual([{ type: "web_search" }]);

      const mergedEmpty = mergeDefaultTools([], ["web_search", "image_generation"]);
      expect(mergedEmpty).toEqual([
        { type: "web_search" },
        { type: "image_generation" },
      ]);
    });

    it("preserves existing client function tools and appends default hosted tools", () => {
      const existing = [
        {
          type: "function",
          function: { name: "get_weather", description: "Fetch weather" },
        },
      ];
      const merged = mergeDefaultTools(existing, ["web_search"]);
      expect(merged).toEqual([
        {
          type: "function",
          function: { name: "get_weather", description: "Fetch weather" },
        },
        { type: "web_search" },
      ]);
    });

    it("deduplicates if request already contains same tool type", () => {
      const existing = [{ type: "web_search" }];
      const merged = mergeDefaultTools(existing, ["web_search"]);
      expect(merged).toEqual([{ type: "web_search" }]);
    });

    it("deduplicates web_search_preview as web_search", () => {
      const existing = [{ type: "web_search_preview" }];
      const merged = mergeDefaultTools(existing, ["web_search"]);
      expect(merged).toEqual([{ type: "web_search_preview" }]);
    });

    it("deduplicates web_search_20250305 against web_search and web_search_preview symmetrically", () => {
      const existing1 = [{ type: "web_search_20250305" }];
      expect(mergeDefaultTools(existing1, ["web_search"])).toEqual([{ type: "web_search_20250305" }]);
      expect(mergeDefaultTools(existing1, ["web_search_preview"])).toEqual([{ type: "web_search_20250305" }]);

      const existing2 = [{ type: "web_search" }];
      expect(mergeDefaultTools(existing2, ["web_search_20250305"])).toEqual([{ type: "web_search" }]);
    });

    it("deduplicates non-search hosted tools (e.g. image_generation, custom_tool)", () => {
      const existing = [{ type: "image_generation" }];
      const merged = mergeDefaultTools(existing, ["image_generation"]);
      expect(merged).toEqual([{ type: "image_generation" }]);

      const existingCustom = [{ type: "calculator" }];
      const mergedCustom = mergeDefaultTools(existingCustom, ["calculator"]);
      expect(mergedCustom).toEqual([{ type: "calculator" }]);
    });
  });

  describe("resolveDefaultTools", () => {
    it("returns empty array when allowUnauthenticated is true (third-party adapter)", async () => {
      const app = new Hono();
      app.get("/test", (c) => {
        const tools = resolveDefaultTools(c, { allowUnauthenticated: true, globalDefaultTools: ["web_search"] });
        return c.json({ tools });
      });

      const res = await app.request("/test");
      const json = await res.json();
      expect(json.tools).toEqual([]);
    });

    it("returns empty array when request has opt-out header (x-codex-default-tools: off)", async () => {
      const app = new Hono();
      app.get("/test", (c) => {
        const tools = resolveDefaultTools(c, { allowUnauthenticated: false, globalDefaultTools: ["web_search"] });
        return c.json({ tools });
      });

      const res = await app.request("/test", {
        headers: { "x-codex-default-tools": "off" },
      });
      const json = await res.json();
      expect(json.tools).toEqual([]);

      const resFalse = await app.request("/test", {
        headers: { "x-codex-default-tools": "false" },
      });
      expect((await resFalse.json()).tools).toEqual([]);

      const resNo = await app.request("/test", {
        headers: { "x-codex-no-default-tools": "1" },
      });
      expect((await resNo.json()).tools).toEqual([]);
    });

    it("inherits global default_tools when clientKey.default_tools is null or undefined", async () => {
      const app = new Hono();
      app.get("/test", (c) => {
        const clientKey: Partial<ClientKeyEntry> = { id: "ck_1", default_tools: null };
        c.set("authRole", "client_key");
        c.set("clientKey", clientKey as ClientKeyEntry);
        const tools = resolveDefaultTools(c, { allowUnauthenticated: false, globalDefaultTools: ["web_search"] });
        return c.json({ tools });
      });

      const res = await app.request("/test");
      expect((await res.json()).tools).toEqual(["web_search"]);
    });

    it("uses clientKey.default_tools override when configured", async () => {
      const app = new Hono();
      app.get("/test", (c) => {
        const clientKey: Partial<ClientKeyEntry> = {
          id: "ck_1",
          default_tools: ["web_search", "image_generation"],
        };
        c.set("authRole", "client_key");
        c.set("clientKey", clientKey as ClientKeyEntry);
        const tools = resolveDefaultTools(c, { allowUnauthenticated: false, globalDefaultTools: [] });
        return c.json({ tools });
      });

      const res = await app.request("/test");
      expect((await res.json()).tools).toEqual(["web_search", "image_generation"]);
    });

    it("respects clientKey.default_tools = [] to disable tools for this specific key", async () => {
      const app = new Hono();
      app.get("/test", (c) => {
        const clientKey: Partial<ClientKeyEntry> = { id: "ck_1", default_tools: [] };
        c.set("authRole", "client_key");
        c.set("clientKey", clientKey as ClientKeyEntry);
        const tools = resolveDefaultTools(c, { allowUnauthenticated: false, globalDefaultTools: ["web_search"] });
        return c.json({ tools });
      });

      const res = await app.request("/test");
      expect((await res.json()).tools).toEqual([]);
    });
  });
});
