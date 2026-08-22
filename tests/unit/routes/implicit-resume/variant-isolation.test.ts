import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { CodexResponsesRequest } from "@src/proxy/codex-api.js";
import {
  createImplicitResumeTestContext,
  cleanupImplicitResumeTestContext,
  getCapturedCodexRequest,
  getCapturedCodexRequests,
  setCapturedCodexRequest,
  type ImplicitResumeContext,
} from "./implicit-resume-setup.js";

describe("Implicit Resume — Variant & Subagent Isolation", () => {
  let ctx: ImplicitResumeContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createImplicitResumeTestContext();
  });

  afterEach(() => {
    cleanupImplicitResumeTestContext(ctx);
  });

  it("Test 5: variantHash 隔离 — 同 conv 不同 system → implicit resume 不复用主对话的 prev id", async () => {
    const sessionId = "shared-session";

    // 主对话第 1 轮：system A，留下 resp-1
    await ctx.chatApp.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        user: sessionId,
        messages: [
          { role: "system", content: "You are MAIN." },
          { role: "user", content: "hi" },
        ],
      }),
    });
    expect(getCapturedCodexRequest().previous_response_id).toBeUndefined();

    // 子代理第 1 轮：同 sessionId，但 system 不同（→ variantHash 不同）。
    // 即便走的是同一个 conv，也不应该错误地继承主对话的 resp-1。
    setCapturedCodexRequest(null);
    await ctx.chatApp.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        user: sessionId,
        messages: [
          { role: "system", content: "You are SUBAGENT." },
          { role: "user", content: "hi" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "next" },
        ],
      }),
    });
    expect(getCapturedCodexRequest().previous_response_id).toBeUndefined();

    // 对照：再来一次同 system A 多轮 → 应仍然能 implicit resume 到 resp-1
    setCapturedCodexRequest(null);
    await ctx.chatApp.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        user: sessionId,
        messages: [
          { role: "system", content: "You are MAIN." },
          { role: "user", content: "hi" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "again" },
        ],
      }),
    });
    expect(getCapturedCodexRequest().previous_response_id).toBe("resp-1");
  });

  it("Test 6: 同 conv 同 variant 多轮 → 各 variant 有自己的 prev id 链", async () => {
    const sessionId = "shared-session-2";

    // 主对话 turn 1 → resp-1 (vh_main)
    await ctx.chatApp.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        user: sessionId,
        messages: [
          { role: "system", content: "MAIN" },
          { role: "user", content: "m1" },
        ],
      }),
    });

    // 子代理 turn 1 → resp-2 (vh_sub)
    await ctx.chatApp.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        user: sessionId,
        messages: [
          { role: "system", content: "SUB" },
          { role: "user", content: "s1" },
        ],
      }),
    });

    // 子代理 turn 2 → 应该续到 resp-2，而不是被主对话的 resp-1 污染
    setCapturedCodexRequest(null);
    await ctx.chatApp.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        user: sessionId,
        messages: [
          { role: "system", content: "SUB" },
          { role: "user", content: "s1" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "s2" },
        ],
      }),
    });
    expect(getCapturedCodexRequest().previous_response_id).toBe("resp-2");

    // 主对话 turn 2 → 应该续到 resp-1
    setCapturedCodexRequest(null);
    await ctx.chatApp.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        user: sessionId,
        messages: [
          { role: "system", content: "MAIN" },
          { role: "user", content: "m1" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "m2" },
        ],
      }),
    });
    expect(getCapturedCodexRequest().previous_response_id).toBe("resp-1");
  });

  it("没有显式 session 的多个对话按首条 user anchor 隔离", async () => {
    const messagesA1 = [
      { role: "system", content: "You are MAIN." },
      { role: "user", content: "root A" },
    ];
    const messagesB1 = [
      { role: "system", content: "You are MAIN." },
      { role: "user", content: "root B" },
    ];

    await ctx.chatApp.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        messages: messagesA1,
      }),
    });
    await ctx.chatApp.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        messages: messagesB1,
      }),
    });
    await ctx.chatApp.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [
          ...messagesA1,
          { role: "assistant", content: "A answer 1" },
          { role: "user", content: "A follow-up" },
        ],
      }),
    });
    await ctx.chatApp.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [
          ...messagesB1,
          { role: "assistant", content: "B answer 1" },
          { role: "user", content: "B follow-up" },
        ],
      }),
    });

    const requests = getCapturedCodexRequests();
    expect(requests).toHaveLength(4);
    expect(requests[0].prompt_cache_key).toBeDefined();
    expect(requests[1].prompt_cache_key).toBeDefined();
    expect(requests[0].prompt_cache_key).not.toBe(requests[1].prompt_cache_key);
    expect(requests[2].prompt_cache_key).toBe(requests[0].prompt_cache_key);
    expect(requests[3].prompt_cache_key).toBe(requests[1].prompt_cache_key);
    expect(requests.map((req) => req.previous_response_id)).toEqual([
      undefined,
      undefined,
      "resp-1",
      "resp-2",
    ]);
    expect(requests.map((req) => req.input)).toEqual([
      [{ role: "user", content: "root A" }],
      [{ role: "user", content: "root B" }],
      [{ role: "user", content: "A follow-up" }],
      [{ role: "user", content: "B follow-up" }],
    ]);
  });

  it("同一 session 下同 system/tools 的多个 subagent 也按首条任务输入隔离", async () => {
    const sessionId = "same-shape-subagents";
    const subagentA = [
      { role: "system", content: "You are SUBAGENT." },
      { role: "user", content: "inspect auth module" },
    ];
    const subagentB = [
      { role: "system", content: "You are SUBAGENT." },
      { role: "user", content: "inspect billing module" },
    ];

    await ctx.chatApp.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        user: sessionId,
        messages: subagentA,
        tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
      }),
    });
    await ctx.chatApp.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        user: sessionId,
        messages: subagentB,
        tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
      }),
    });
    await ctx.chatApp.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        user: sessionId,
        messages: [
          ...subagentA,
          { role: "assistant", content: "auth findings" },
          { role: "user", content: "continue auth" },
        ],
        tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
      }),
    });
    await ctx.chatApp.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        user: sessionId,
        messages: [
          ...subagentB,
          { role: "assistant", content: "billing findings" },
          { role: "user", content: "continue billing" },
        ],
        tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
      }),
    });

    const requests = getCapturedCodexRequests();
    expect(requests).toHaveLength(4);
    expect(requests.map((req) => req.prompt_cache_key)).toEqual([
      sessionId,
      sessionId,
      sessionId,
      sessionId,
    ]);
    expect(requests.map((req) => req.previous_response_id)).toEqual([
      undefined,
      undefined,
      "resp-1",
      "resp-2",
    ]);
    expect(requests.map((req) => req.input)).toEqual([
      [{ role: "user", content: "inspect auth module" }],
      [{ role: "user", content: "inspect billing module" }],
      [{ role: "user", content: "continue auth" }],
      [{ role: "user", content: "continue billing" }],
    ]);
  });

  it("同一 session 下完全相同的 subagent 按 Codex window id 隔离", async () => {
    const sessionId = "identical-subagents";
    const rootInput: CodexResponsesRequest["input"] = [
      { role: "user", content: "inspect the selected module" },
    ];
    const followUpInput: CodexResponsesRequest["input"] = [
      ...rootInput,
      { role: "assistant", content: "module findings" },
      { role: "user", content: "continue" },
    ];
    const tools = [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }];
    const buildRequest = (
      codexWindowId: string,
      input: CodexResponsesRequest["input"],
    ): CodexResponsesRequest => ({
      model: "gpt-4",
      instructions: "You are SUBAGENT.",
      input,
      stream: true,
      store: false,
      prompt_cache_key: sessionId,
      codexWindowId,
      tools,
    });

    await ctx.directProxyApp.request("/direct", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildRequest("identical-subagents:1", rootInput)),
    });
    await ctx.directProxyApp.request("/direct", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildRequest("identical-subagents:2", rootInput)),
    });
    await ctx.directProxyApp.request("/direct", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildRequest("identical-subagents:1", followUpInput)),
    });
    await ctx.directProxyApp.request("/direct", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildRequest("identical-subagents:2", followUpInput)),
    });

    const requests = getCapturedCodexRequests();
    expect(requests).toHaveLength(4);
    expect(requests.map((req) => req.prompt_cache_key)).toEqual([
      sessionId,
      sessionId,
      sessionId,
      sessionId,
    ]);
    expect(requests.map((req) => req.codexWindowId)).toEqual([
      "identical-subagents:1",
      "identical-subagents:2",
      "identical-subagents:1",
      "identical-subagents:2",
    ]);
    expect(requests.map((req) => req.previous_response_id)).toEqual([
      undefined,
      undefined,
      "resp-1",
      "resp-2",
    ]);
    expect(requests.map((req) => req.input)).toEqual([
      [{ role: "user", content: "inspect the selected module" }],
      [{ role: "user", content: "inspect the selected module" }],
      [{ role: "user", content: "continue" }],
      [{ role: "user", content: "continue" }],
    ]);
  });
});
