/**
 * POST /v1/images/generations 的集成测试。
 *
 * 只替换外部传输边界；账号池、CodexApi、共享 proxy-handler 和 Images 转换
 * 均运行真实实现。
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  setTransportPost,
  resetTransportState,
  getLastTransportBody,
  getMockTransport,
  makeTransportResponse,
  makeErrorTransportResponse,
} from "@helpers/e2e-setup.js";
import { buildImageGenStreamChunks, buildTextStreamChunks, sseChunk } from "@helpers/sse.js";
import { createValidJwt } from "@helpers/jwt.js";

import { getConfig } from "@src/config.js";
import { Hono } from "hono";
import { requestId } from "@src/middleware/request-id.js";
import { errorHandler } from "@src/middleware/error-handler.js";
import { createImagesRoutes } from "@src/routes/images.js";
import { AccountPool } from "@src/auth/account-pool.js";
import { ClientKeyPool } from "@src/auth/client-key-pool.js";
import { ClientKeyPersistence } from "@src/auth/client-key-persistence.js";
import { CookieJar } from "@src/proxy/cookie-jar.js";
import { ProxyPool } from "@src/proxy/proxy-pool.js";
import { loadStaticModels } from "@src/models/model-store.js";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

interface TestContext {
  app: Hono;
  accountPool: AccountPool;
  cookieJar: CookieJar;
  proxyPool: ProxyPool;
  clientKeyPool: ClientKeyPool;
  tempDir: string;
}

let ctx: TestContext;

function buildApp(opts?: { noAccount?: boolean; clientKeyPool?: ClientKeyPool; router?: unknown }): TestContext {
  loadStaticModels();
  const accountPool = new AccountPool();
  const cookieJar = new CookieJar();
  const proxyPool = new ProxyPool();
  const tempDir = mkdtempSync(join(tmpdir(), "client-key-images-e2e-"));
  const persistence = new ClientKeyPersistence(
    join(tempDir, "client-keys.sqlite"),
    join(tempDir, "client-keys.json"),
  );
  const clientKeyPool = opts?.clientKeyPool ?? new ClientKeyPool(persistence, () => getConfig().server.proxy_api_key);

  if (!opts?.noAccount) {
    accountPool.addAccount(createValidJwt({
      accountId: "acct-e2e-images",
      email: "images@test.com",
      planType: "plus",
    }));
  }

  const app = new Hono();
  app.use("*", requestId);
  app.onError(errorHandler);
  app.route("/", createImagesRoutes(accountPool, cookieJar, proxyPool, clientKeyPool, opts?.router as never));
  return { app, accountPool, cookieJar, proxyPool, clientKeyPool, tempDir };
}

beforeEach(() => {
  resetTransportState();
  (getConfig().server as { proxy_api_key: string | null }).proxy_api_key = null;
  (getConfig().model as { image_host_model: string }).image_host_model = "gpt-5.5";
  (getConfig().model as unknown as { aliases: Record<string, string> }).aliases = {};
  (getConfig().model as unknown as { custom_models: Array<string | { id: string }> }).custom_models = [];
  setTransportPost(async () =>
    makeTransportResponse(buildImageGenStreamChunks(
      "resp_images_default",
      "item_images_default",
      "ZmFrZS1pbWFnZQ==",
      "default prompt",
    )),
  );
  vi.mocked(getMockTransport().post).mockClear();
  ctx = buildApp();
});

afterEach(() => {
  ctx.cookieJar.destroy();
  ctx.proxyPool.destroy();
  ctx.accountPool.destroy();
  try {
    rmSync(ctx.tempDir, { recursive: true, force: true });
  } catch {
    // cleanup
  }
});

function imagesRequest(body: unknown, app = ctx.app): Promise<Response> {
  return app.request("/v1/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/images/generations", () => {
  it("maps an Images request to the configured Codex host and returns b64_json", async () => {
    setTransportPost(async () =>
      makeTransportResponse(buildImageGenStreamChunks(
        "resp_images_ok",
        "item_images_ok",
        "ZmFrZS1wbmc=",
        "a revised prompt",
      )),
    );

    const res = await imagesRequest({
      model: "gpt-image-2",
      prompt: "a red circle",
      size: "1024x1024",
      quality: "hd",
      output_format: "jpeg",
      output_compression: 80,
      background: "opaque",
      moderation: "low",
      partial_images: 2,
      n: 1,
      response_format: "b64_json",
    });

    expect(res.status).toBe(200);
    const body = await res.json() as {
      created: number;
      data: Array<{ b64_json: string; revised_prompt?: string }>;
    };
    expect(body.created).toEqual(expect.any(Number));
    expect(body.data).toEqual([{
      b64_json: "ZmFrZS1wbmc=",
      revised_prompt: "a revised prompt",
    }]);

    const sent = JSON.parse(getLastTransportBody()!);
    expect(sent.model).toBe("gpt-5.5");
    expect(sent.model).not.toBe("gpt-image-2");
    expect(sent.input).toEqual([{
      role: "user",
      content: [{ type: "input_text", text: "a red circle" }],
    }]);
    expect(sent.tools).toEqual([{
      type: "image_generation",
      size: "1024x1024",
      output_format: "jpeg",
      output_compression: 80,
      background: "opaque",
      moderation: "low",
      partial_images: 2,
    }]);
    expect(sent.tools[0].quality).toBeUndefined();
    const account = ctx.accountPool.getAllEntries()[0];
    expect(account?.usage.image_output_tokens).toBe(1);
    expect(account?.usage.image_request_count).toBe(1);
    expect(account?.usage.image_request_failed_count ?? 0).toBe(0);
  });

  it("forwards a newly configured image host model upstream", async () => {
    (getConfig().model as { image_host_model: string }).image_host_model = "gpt-5.4";
    ctx = buildApp();

    const res = await imagesRequest({
      model: "gpt-image-2",
      prompt: "a red circle",
    });

    expect(res.status).toBe(200);
    const sent = JSON.parse(getLastTransportBody()!);
    expect(sent.model).toBe("gpt-5.4");
    expect(sent.model).not.toBe("gpt-image-2");
  });

  it("resolves an alias image host model to its canonical catalog model", async () => {
    (getConfig().model as unknown as { aliases: Record<string, string> }).aliases = { "img-fast": "gpt-5.4" };
    (getConfig().model as { image_host_model: string }).image_host_model = "img-fast";
    ctx = buildApp();

    const res = await imagesRequest({
      model: "gpt-image-2",
      prompt: "a red circle",
    });

    expect(res.status).toBe(200);
    const sent = JSON.parse(getLastTransportBody()!);
    expect(sent.model).toBe("gpt-5.4");
    expect(sent.model).not.toBe("img-fast");
    expect(sent.model).not.toBe("gpt-image-2");
  });

  it("rejects n other than one and unsupported response formats before upstream", async () => {
    const invalidN = await imagesRequest({
      model: "gpt-image-2",
      prompt: "a red circle",
      n: 2,
    });
    expect(invalidN.status).toBe(400);
    expect((await invalidN.json() as { error: { type: string } }).error.type)
      .toBe("invalid_request_error");
    expect(getMockTransport().post).not.toHaveBeenCalled();

    const invalidFormat = await imagesRequest({
      model: "gpt-image-2",
      prompt: "a red circle",
      response_format: "url",
    });
    expect(invalidFormat.status).toBe(400);
    expect(getMockTransport().post).not.toHaveBeenCalled();

    const oversizedPrompt = await imagesRequest({
      model: "gpt-image-2",
      prompt: "a".repeat(32769),
    });
    expect(oversizedPrompt.status).toBe(400);
    expect(getMockTransport().post).not.toHaveBeenCalled();
  });

  it("rejects a PNG compression override that the Codex image tool cannot use", async () => {
    const res = await imagesRequest({
      model: "gpt-image-2",
      prompt: "a red circle",
      output_format: "png",
      output_compression: 80,
    });

    expect(res.status).toBe(400);
    expect(getMockTransport().post).not.toHaveBeenCalled();
  });

  it("applies PNG compression validation when output_format is omitted", async () => {
    const res = await imagesRequest({
      model: "gpt-image-2",
      prompt: "a red circle",
      output_compression: 80,
    });

    expect(res.status).toBe(400);
    expect(getMockTransport().post).not.toHaveBeenCalled();
  });

  it("fails and records an image failure when response.completed is missing", async () => {
    setTransportPost(async () => makeTransportResponse(
      sseChunk("response.created", { response: { id: "resp_images_truncated" } })
      + sseChunk("response.output_item.done", {
        outputIndex: 0,
        item: {
          type: "image_generation_call",
          id: "item_images_truncated",
          result: "ZmFrZS1pbWFnZQ==",
        },
      }),
    ));

    const res = await imagesRequest({
      model: "gpt-image-2",
      prompt: "a red circle",
    });

    expect(res.status).toBe(502);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("image_generation_failed");
    const account = ctx.accountPool.getAllEntries()[0];
    expect(account?.usage.image_request_count ?? 0).toBe(0);
    expect(account?.usage.image_request_failed_count).toBe(1);
  });

  it("succeeds when response.completed carries an empty output array but an earlier output_item.done had the image", async () => {
    // Real upstream behavior (verified against the live Codex Responses API):
    // response.completed routinely reports an empty `output: []` even for a
    // fully successful image generation — the actual result only ever
    // appears once, on the earlier output_item.done event. An empty output
    // array on response.completed must NOT be treated as "no image", or
    // every real successful Images request would fail.
    setTransportPost(async () => makeTransportResponse(
      sseChunk("response.created", { response: { id: "resp_images_empty_output" } })
      + sseChunk("response.output_item.done", {
        outputIndex: 0,
        item: {
          type: "image_generation_call",
          id: "item_images_real",
          result: "ZmFrZS1pbWFnZQ==",
        },
      })
      + sseChunk("response.completed", {
        response: {
          id: "resp_images_empty_output",
          output: [],
          usage: { input_tokens: 10, output_tokens: 10 },
        },
      }),
    ));

    const res = await imagesRequest({
      model: "gpt-image-2",
      prompt: "a red circle",
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<{ b64_json: string }> };
    expect(body.data[0]?.b64_json).toBe("ZmFrZS1pbWFnZQ==");
  });

  it("fails when response.completed explicitly enumerates output with no image in it", async () => {
    // Distinguish from the empty-array case above: a *non-empty* output
    // array is authoritative. If upstream bothers to enumerate the final
    // items and none is an image, that overrides an earlier (now known
    // stale) output_item.done result.
    setTransportPost(async () => makeTransportResponse(
      sseChunk("response.created", { response: { id: "resp_images_no_image_in_output" } })
      + sseChunk("response.output_item.done", {
        outputIndex: 0,
        item: {
          type: "image_generation_call",
          id: "item_images_stale",
          result: "ZmFrZS1pbWFnZQ==",
        },
      })
      + sseChunk("response.completed", {
        response: {
          id: "resp_images_no_image_in_output",
          output: [{ type: "message", id: "msg_1", content: [] }],
          usage: { input_tokens: 10, output_tokens: 10 },
        },
      }),
    ));

    const res = await imagesRequest({
      model: "gpt-image-2",
      prompt: "a red circle",
    });

    expect(res.status).toBe(502);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("image_generation_failed");
    const account = ctx.accountPool.getAllEntries()[0];
    expect(account?.usage.image_request_count ?? 0).toBe(0);
    expect(account?.usage.image_request_failed_count).toBe(1);
  });

  it("fails explicitly when upstream returns text without an image result", async () => {
    setTransportPost(async () =>
      makeTransportResponse(buildTextStreamChunks("resp_images_empty", "<svg>not an image</svg>")),
    );

    const res = await imagesRequest({
      model: "gpt-image-2",
      prompt: "a red circle",
    });

    expect(res.status).toBe(502);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("image_generation_failed");
    expect(body.error.message).toContain("no image_generation_call.result");
  });

  it("formats upstream 429 as a rate limit error", async () => {
    setTransportPost(async () =>
      makeErrorTransportResponse(429, JSON.stringify({ detail: "Rate limited" })),
    );

    const res = await imagesRequest({
      model: "gpt-image-2",
      prompt: "a red circle",
    });

    expect(res.status).toBe(429);
    const body = await res.json() as { error: { type: string; code: string } };
    expect(body.error.type).toBe("rate_limit_error");
    expect(body.error.code).toBe("rate_limit_exceeded");
  });

  it("rejects an image host model that is not a routable Codex model", async () => {
    (getConfig().model as { image_host_model: string }).image_host_model = "gpt-image-2";
    const imageToolHost = await imagesRequest({
      model: "gpt-image-2",
      prompt: "a red circle",
    });
    expect(imageToolHost.status).toBe(500);
    expect((await imageToolHost.json() as { error: { code: string } }).error.code)
      .toBe("image_host_model_invalid");
    expect(getMockTransport().post).not.toHaveBeenCalled();

    (getConfig().model as { image_host_model: string }).image_host_model = "not-in-model-catalog";
    const unknownHost = await imagesRequest({
      model: "gpt-image-2",
      prompt: "a red circle",
    });
    expect(unknownHost.status).toBe(500);
    expect((await unknownHost.json() as { error: { code: string } }).error.code)
      .toBe("image_host_model_invalid");
    expect(getMockTransport().post).not.toHaveBeenCalled();
  });

  it("requires an authenticated account before attempting upstream", async () => {
    const noAccount = buildApp({ noAccount: true });
    const res = await imagesRequest({
      model: "gpt-image-2",
      prompt: "a red circle",
    }, noAccount.app);

    expect(res.status).toBe(401);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("invalid_api_key");
    expect(getMockTransport().post).not.toHaveBeenCalled();
    noAccount.cookieJar.destroy();
    noAccount.proxyPool.destroy();
    noAccount.accountPool.destroy();
  });

  it("enforces the configured proxy API key", async () => {
    (getConfig().server as { proxy_api_key: string | null }).proxy_api_key = "images-secret";

    const missing = await imagesRequest({ model: "gpt-image-2", prompt: "a red circle" });
    expect(missing.status).toBe(401);
    expect(getMockTransport().post).not.toHaveBeenCalled();

    vi.mocked(getMockTransport().post).mockClear();
    const valid = await ctx.app.request("/v1/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer images-secret",
      },
      body: JSON.stringify({ model: "gpt-image-2", prompt: "a red circle" }),
    });
    expect(valid.status).toBe(200);
    expect(getLastTransportBody()).toBeTruthy();
  });

  it("handles requests on the /images/generations route alias", async () => {
    const res = await ctx.app.request("/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-image-2", prompt: "a red circle" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<{ b64_json: string }> };
    expect(body.data[0]?.b64_json).toBe("ZmFrZS1pbWFnZQ==");
  });

  it("authenticates valid client key when proxy API key is configured", async () => {
    (getConfig().server as { proxy_api_key: string | null }).proxy_api_key = "master-secret";
    const clientKey = ctx.clientKeyPool.createKey({ name: "test-client" });

    const res = await ctx.app.request("/v1/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${clientKey.key}`,
      },
      body: JSON.stringify({ model: "gpt-image-2", prompt: "a red circle" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<{ b64_json: string }> };
    expect(body.data[0]?.b64_json).toBe("ZmFrZS1pbWFnZQ==");
  });

  it("enforces allowed_models on client keys", async () => {
    (getConfig().server as { proxy_api_key: string | null }).proxy_api_key = "master-secret";
    const disallowedKey = ctx.clientKeyPool.createKey({
      name: "restricted-client",
      allowed_models: ["gpt-4o"],
    });

    const forbiddenRes = await ctx.app.request("/v1/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${disallowedKey.key}`,
      },
      body: JSON.stringify({ model: "gpt-image-2", prompt: "a red circle" }),
    });

    expect(forbiddenRes.status).toBe(403);
    const forbiddenBody = await forbiddenRes.json() as { error: { code: string } };
    expect(forbiddenBody.error.code).toBe("model_not_allowed");

    const allowedKey = ctx.clientKeyPool.createKey({
      name: "images-client",
      allowed_models: ["gpt-image-2"],
    });

    const allowedRes = await ctx.app.request("/v1/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${allowedKey.key}`,
      },
      body: JSON.stringify({ model: "gpt-image-2", prompt: "a red circle" }),
    });

    expect(allowedRes.status).toBe(200);
  });

  it("enforces concurrency limits on client keys", async () => {
    (getConfig().server as { proxy_api_key: string | null }).proxy_api_key = "master-secret";
    const clientKey = ctx.clientKeyPool.createKey({
      name: "concurrency-client",
      max_concurrency: 1,
    });

    // Acquire the only slot
    expect(ctx.clientKeyPool.acquireSlot(clientKey.id)).toBe(true);

    const res = await ctx.app.request("/v1/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${clientKey.key}`,
      },
      body: JSON.stringify({ model: "gpt-image-2", prompt: "a red circle" }),
    });

    expect(res.status).toBe(429);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("concurrency_limit_exceeded");

    ctx.clientKeyPool.releaseSlot(clientKey.id);
  });
});

describe("POST /v1/images/edits", () => {
  const editBody = {
    model: "gpt-image-2",
    prompt: "Fill the image with solid blue.",
    images: [{ image_url: "data:image/png;base64,AAAA" }],
  };

  function editsRequest(body: unknown, app = ctx.app): Promise<Response> {
    return app.request("/v1/images/edits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("maps an Images edits request to an Edit-mode Codex request and returns b64_json", async () => {
    const res = await editsRequest({
      ...editBody,
      size: "1024x1024",
      quality: "high",
      output_format: "png",
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { created: number; data: Array<{ b64_json: string }> };
    expect(body.created).toEqual(expect.any(Number));
    expect(body.data[0]?.b64_json).toBe("ZmFrZS1pbWFnZQ==");

    const sent = JSON.parse(getLastTransportBody()!);
    expect(sent.model).toBe("gpt-5.5");
    expect(sent.model).not.toBe("gpt-image-2");
    expect(sent.input).toEqual([{
      role: "user",
      content: [
        { type: "input_text", text: editBody.prompt },
        { type: "input_image", image_url: "data:image/png;base64,AAAA" },
      ],
    }]);
    expect(sent.tools).toEqual([{
      type: "image_generation",
      size: "1024x1024",
      output_format: "png",
      quality: "high",
    }]);
    expect(sent.stream).toBe(true);
  });

  it("accepts the /images/edits route alias", async () => {
    const res = await ctx.app.request("/images/edits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editBody),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<{ b64_json: string }> };
    expect(body.data[0]?.b64_json).toBe("ZmFrZS1pbWFnZQ==");
  });

  it.each([
    ["missing images array", { model: "gpt-image-2", prompt: "p" }, null],
    ["empty images array", { model: "gpt-image-2", prompt: "p", images: [] }, null],
    [
      "bad image_url scheme",
      { model: "gpt-image-2", prompt: "p", images: [{ image_url: "not-a-url" }] },
      "image_url must be a data: or http(s) URL",
    ],
    [
      "n other than one",
      { model: "gpt-image-2", prompt: "p", images: [{ image_url: "data:image/png;base64,AAAA" }], n: 2 },
      null,
    ],
    [
      "png compression override",
      { model: "gpt-image-2", prompt: "p", images: [{ image_url: "data:image/png;base64,AAAA" }], output_compression: 80 },
      "output_compression must be 100 when output_format is png",
    ],
  ])("rejects an invalid edits request before upstream: %s", async (_label, body, needle) => {
    const res = await editsRequest(body);

    expect(res.status).toBe(400);
    const err = await res.json() as { error: { code: string; message: string } };
    expect(err.error.code).toBe("invalid_request");
    if (needle) expect(err.error.message).toContain(needle);
    expect(getMockTransport().post).not.toHaveBeenCalled();
  });

  it("requires an authenticated account before attempting upstream", async () => {
    const noAccount = buildApp({ noAccount: true });

    const res = await editsRequest(editBody, noAccount.app);

    expect(res.status).toBe(401);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("invalid_api_key");
    expect(getMockTransport().post).not.toHaveBeenCalled();
    noAccount.cookieJar.destroy();
    noAccount.proxyPool.destroy();
    noAccount.accountPool.destroy();
  });
});

describe("images route model dispatch", () => {
  function buildRoutedApp(resolveMatch: unknown): TestContext {
    return buildApp({ router: { resolveMatch: vi.fn(() => resolveMatch) } });
  }

  function destroyBuilt(built: TestContext): void {
    built.cookieJar.destroy();
    built.proxyPool.destroy();
    built.accountPool.destroy();
  }

  it("routes api-key-wired models through the Codex JSON passthrough verbatim", async () => {
    const forwardCodexJsonRequest = vi.fn(async () => new Response(
      JSON.stringify({ endpoint: "images/edits", ok: true }),
      {
        status: 200,
        headers: new Headers({
          "Content-Type": "application/json",
          "x-request-id": "upstream-rid",
          "Set-Cookie": "provider-secret=hidden",
          Authorization: "Bearer upstream-secret",
        }),
      },
    ));
    const built = buildRoutedApp({
      kind: "api-key",
      adapter: { tag: "codex-responses", forwardCodexJsonRequest },
    });
    const requestBody = {
      model: "gpt-image-2",
      prompt: "p",
      images: [{ image_url: "data:image/png;base64,AAAA" }],
      provider_extension: { preserved: true },
    };

    const res = await built.app.request("/v1/images/edits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBe("upstream-rid");
    expect(res.headers.get("set-cookie")).toBeNull();
    await expect(res.json()).resolves.toEqual({ endpoint: "images/edits", ok: true });
    expect(forwardCodexJsonRequest).toHaveBeenCalledWith(
      "images/edits",
      requestBody,
      expect.anything(),
      expect.anything(),
    );
    destroyBuilt(built);
  });

  it("rewrites the model through routeMatch.resolvedModel on the generations passthrough", async () => {
    const forwardCodexJsonRequest = vi.fn(async () => new Response(
      JSON.stringify({ ok: true }),
      { status: 200, headers: new Headers({ "Content-Type": "application/json" }) },
    ));
    const built = buildRoutedApp({
      kind: "adapter",
      adapter: { tag: "codex-responses", forwardCodexJsonRequest },
      resolvedModel: "resolved-image-model",
    });

    const res = await built.app.request("/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-image-2", prompt: "p" }),
    });

    expect(res.status).toBe(200);
    expect(forwardCodexJsonRequest).toHaveBeenCalledWith(
      "images/generations",
      expect.objectContaining({ model: "resolved-image-model" }),
      expect.anything(),
      expect.anything(),
    );
    destroyBuilt(built);
  });

  it("fails closed for adapters without Codex JSON support", async () => {
    const built = buildRoutedApp({ kind: "adapter", adapter: { tag: "responses" } });

    const res = await built.app.request("/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "my-model", prompt: "p" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("unsupported_codex_auxiliary_route");
    expect(getMockTransport().post).not.toHaveBeenCalled();
    destroyBuilt(built);
  });

  it("returns model_not_found for unrouted models", async () => {
    const built = buildRoutedApp({ kind: "not-found" });

    const res = await built.app.request("/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-9999", prompt: "p" }),
    });

    expect(res.status).toBe(404);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("model_not_found");
    expect(getMockTransport().post).not.toHaveBeenCalled();
    destroyBuilt(built);
  });

  it("routes codex-kind models to the account conversion when a router is present", async () => {
    const built = buildRoutedApp({ kind: "codex" });

    const res = await built.app.request("/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-image-2", prompt: "a red circle" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<{ b64_json: string }> };
    expect(body.data[0]?.b64_json).toBe("ZmFrZS1pbWFnZQ==");
    const sent = JSON.parse(getLastTransportBody()!);
    expect(sent.model).toBe("gpt-5.5");
    expect(sent.input[0].content).toEqual([{ type: "input_text", text: "a red circle" }]);
    destroyBuilt(built);
  });
});

describe("POST /v1/images/edits (multipart)", () => {
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  function pngBlob(): Blob {
    return new Blob([pngBytes], { type: "image/png" });
  }

  function multipartForm(): FormData {
    const form = new FormData();
    form.append("model", "gpt-image-2");
    form.append("prompt", "Fill the image with solid blue.");
    return form;
  }

  function multipartEdits(form: FormData, app = ctx.app): Promise<Response> {
    // Request 构造器会为 FormData body 自动附加带 boundary 的 multipart Content-Type。
    return app.request("/v1/images/edits", { method: "POST", body: form });
  }

  it("accepts a multipart file upload and converts it to the Codex JSON protocol", async () => {
    const form = multipartForm();
    form.append("image", pngBlob(), "t.png");
    form.append("size", "1024x1024");

    const res = await multipartEdits(form);

    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<{ b64_json: string }> };
    expect(body.data[0]?.b64_json).toBe("ZmFrZS1pbWFnZQ==");

    const sent = JSON.parse(getLastTransportBody()!);
    const parts = sent.input[0].content;
    expect(parts[0]).toEqual({ type: "input_text", text: "Fill the image with solid blue." });
    expect(parts[1].type).toBe("input_image");
    expect(parts[1].image_url).toMatch(/^data:image\/png;base64,/);
    const decoded = Buffer.from((parts[1].image_url as string).split(",")[1]!, "base64");
    expect(Buffer.compare(decoded, Buffer.from(pngBytes))).toBe(0);
    expect(sent.tools[0]).toEqual({ type: "image_generation", size: "1024x1024", output_format: "png" });
  });

  it("accepts repeated image[] parts as multiple reference images", async () => {
    const form = multipartForm();
    form.append("image[]", pngBlob(), "a.png");
    form.append("image[]", pngBlob(), "b.png");

    const res = await multipartEdits(form);

    expect(res.status).toBe(200);
    const sent = JSON.parse(getLastTransportBody()!);
    const images = sent.input[0].content.filter((p: { type: string }) => p.type === "input_image");
    expect(images).toHaveLength(2);
    expect(images.every((p: { image_url: string }) => p.image_url.startsWith("data:image/png;base64,"))).toBe(true);
  });

  it("routes multipart through the api-key passthrough as the converted JSON body", async () => {
    const forwardCodexJsonRequest = vi.fn(async () => new Response(
      JSON.stringify({ ok: true }),
      { status: 200, headers: new Headers({ "Content-Type": "application/json" }) },
    ));
    const built = buildApp({
      router: { resolveMatch: vi.fn(() => ({ kind: "api-key", adapter: { tag: "codex-responses", forwardCodexJsonRequest } })) },
    });
    const form = multipartForm();
    form.append("image", pngBlob(), "t.png");

    const res = await multipartEdits(form, built.app);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(forwardCodexJsonRequest).toHaveBeenCalledTimes(1);
    const [path, body] = forwardCodexJsonRequest.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe("images/edits");
    expect(body.model).toBe("gpt-image-2");
    expect(body.prompt).toBe("Fill the image with solid blue.");
    const images = body.images as Array<{ image_url: string }>;
    expect(images[0]?.image_url).toMatch(/^data:image\/png;base64,/);
    built.cookieJar.destroy();
    built.proxyPool.destroy();
    built.accountPool.destroy();
  });

  it("rejects a mask file with an explicit unsupported error", async () => {
    const form = multipartForm();
    form.append("image", pngBlob(), "t.png");
    form.append("mask", pngBlob(), "mask.png");

    const res = await multipartEdits(form);

    expect(res.status).toBe(400);
    const err = await res.json() as { error: { code: string; message: string } };
    expect(err.error.code).toBe("invalid_request");
    expect(err.error.message).toContain("mask is not supported");
    expect(getMockTransport().post).not.toHaveBeenCalled();
  });

  it("rejects response_format other than b64_json", async () => {
    const form = multipartForm();
    form.append("image", pngBlob(), "t.png");
    form.append("response_format", "url");

    const res = await multipartEdits(form);

    expect(res.status).toBe(400);
    const err = await res.json() as { error: { message: string } };
    expect(err.error.message).toContain("response_format=b64_json");
  });

  it("rejects multipart file uploads on generations", async () => {
    const form = new FormData();
    form.append("model", "gpt-image-2");
    form.append("prompt", "a red circle");
    form.append("image", pngBlob(), "t.png");

    const res = await ctx.app.request("/v1/images/generations", { method: "POST", body: form });

    expect(res.status).toBe(400);
    const err = await res.json() as { error: { message: string } };
    expect(err.error.message).toContain("only supported on /v1/images/edits");
    expect(getMockTransport().post).not.toHaveBeenCalled();
  });

  it("requires an authenticated account for multipart edits", async () => {
    const noAccount = buildApp({ noAccount: true });
    const form = multipartForm();
    form.append("image", pngBlob(), "t.png");

    const res = await multipartEdits(form, noAccount.app);

    expect(res.status).toBe(401);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("invalid_api_key");
    noAccount.cookieJar.destroy();
    noAccount.proxyPool.destroy();
    noAccount.accountPool.destroy();
  });
});
