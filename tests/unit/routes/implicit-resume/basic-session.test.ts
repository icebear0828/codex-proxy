import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getSessionAffinityMap } from "@src/auth/session-affinity.js";
import {
  createImplicitResumeTestContext,
  cleanupImplicitResumeTestContext,
  getCapturedCodexRequest,
  type ImplicitResumeContext,
} from "./implicit-resume-setup.js";

describe("Implicit Resume — Basic Session & Key Derivation", () => {
  let ctx: ImplicitResumeContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createImplicitResumeTestContext();
  });

  afterEach(() => {
    cleanupImplicitResumeTestContext(ctx);
  });

  it("Test 1 & 2: Chat endpoint uses derived key and triggers implicit resume on multi-turn", async () => {
    // Turn 1
    const t1Input = [{ role: "user", content: "First message" }];
    await ctx.chatApp.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        messages: t1Input,
      }),
    });

    let captured = getCapturedCodexRequest();
    expect(captured.previous_response_id).toBeUndefined(); // First turn, no implicit resume
    const derivedKeyT1 = captured.prompt_cache_key;
    expect(derivedKeyT1).toBeDefined();

    // Turn 2: Client sends the history
    const t2Input = [
      ...t1Input,
      { role: "assistant", content: "ok" },
      { role: "user", content: "Hello again" },
    ];

    await ctx.chatApp.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        messages: t2Input,
      }),
    });

    // T2 should have triggered implicit resume
    captured = getCapturedCodexRequest();
    expect(captured.previous_response_id).toBe("resp-1");
    expect(captured.input).toEqual([{ role: "user", content: "Hello again" }]);
  });

  it("Test 1 & 2b: Chat endpoint uses client session via 'user' field if provided", async () => {
    const explicitUserId = "client-provided-session-uuid";
    const req1 = await ctx.chatApp.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "Hi" }],
        user: explicitUserId,
      }),
    });
    expect(req1.status).toBe(200);
    expect(getCapturedCodexRequest().prompt_cache_key).toBe(explicitUserId);

    // The chainConversationId used for affinity should be the client ID
    const affinityMap = getSessionAffinityMap();
    expect(affinityMap.lookupConversationId("resp-1")).toBe(explicitUserId);
  });

  it("Test 3: Gemini route extracts session ID from headers", async () => {
    const req1 = await ctx.geminiApp.request("/v1beta/models/gemini-1.5-pro:generateContent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-session-id": "gemini-test-session-id",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
      }),
    });
    expect(req1.status).toBe(200);
    expect(getCapturedCodexRequest().prompt_cache_key).toBe("gemini-test-session-id");

    const affinityMap = getSessionAffinityMap();
    expect(affinityMap.lookupConversationId("resp-1")).toBe("gemini-test-session-id");
  });

  it("Test 4: Empty requests do not crash and fallback to random UUID promptCacheKey", async () => {
    const req1 = await ctx.chatApp.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "" }],
      }),
    });
    expect(req1.status).toBe(200);

    // Derived key will be null for empty request, so promptCacheKey will be UUID
    const promptCacheKey = getCapturedCodexRequest().prompt_cache_key;
    expect(promptCacheKey).toBeDefined();
    expect(promptCacheKey?.length).toBeGreaterThan(16); // UUID
  });
});
