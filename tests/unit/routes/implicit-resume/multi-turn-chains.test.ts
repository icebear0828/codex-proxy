import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createImplicitResumeTestContext,
  cleanupImplicitResumeTestContext,
  getCapturedCodexRequests,
  type ImplicitResumeContext,
} from "./implicit-resume-setup.js";

describe("Implicit Resume — Multi-Turn Chains & Delta Inputs", () => {
  let ctx: ImplicitResumeContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createImplicitResumeTestContext();
  });

  afterEach(() => {
    cleanupImplicitResumeTestContext(ctx);
  });

  it("同一对话连续多轮只发送新增输入，避免完整历史越滚越大", async () => {
    const sessionId = "single-thread-many-turns";
    const base = [
      { role: "system", content: "You are MAIN." },
      { role: "user", content: "turn 1" },
    ];

    await ctx.chatApp.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        user: sessionId,
        messages: base,
      }),
    });

    await ctx.chatApp.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        user: sessionId,
        messages: [
          ...base,
          { role: "assistant", content: "answer 1" },
          { role: "user", content: "turn 2" },
        ],
      }),
    });

    await ctx.chatApp.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        user: sessionId,
        messages: [
          ...base,
          { role: "assistant", content: "answer 1" },
          { role: "user", content: "turn 2" },
          { role: "assistant", content: "answer 2" },
          { role: "user", content: "turn 3" },
        ],
      }),
    });

    await ctx.chatApp.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        user: sessionId,
        messages: [
          ...base,
          { role: "assistant", content: "answer 1" },
          { role: "user", content: "turn 2" },
          { role: "assistant", content: "answer 2" },
          { role: "user", content: "turn 3" },
          { role: "assistant", content: "answer 3" },
          { role: "user", content: "turn 4" },
        ],
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
      "resp-1",
      "resp-2",
      "resp-3",
    ]);
    expect(requests.map((req) => req.input)).toEqual([
      [{ role: "user", content: "turn 1" }],
      [{ role: "user", content: "turn 2" }],
      [{ role: "user", content: "turn 3" }],
      [{ role: "user", content: "turn 4" }],
    ]);
  });

  it("多个显式对话交错多轮时各自续自己的 prev id 链", async () => {
    const messagesA1 = [
      { role: "system", content: "You are MAIN." },
      { role: "user", content: "A turn 1" },
    ];
    const messagesB1 = [
      { role: "system", content: "You are MAIN." },
      { role: "user", content: "B turn 1" },
    ];

    await ctx.chatApp.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        user: "thread-A",
        messages: messagesA1,
      }),
    });
    await ctx.chatApp.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        user: "thread-B",
        messages: messagesB1,
      }),
    });
    await ctx.chatApp.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        user: "thread-A",
        messages: [
          ...messagesA1,
          { role: "assistant", content: "A answer 1" },
          { role: "user", content: "A turn 2" },
        ],
      }),
    });
    await ctx.chatApp.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        user: "thread-B",
        messages: [
          ...messagesB1,
          { role: "assistant", content: "B answer 1" },
          { role: "user", content: "B turn 2" },
        ],
      }),
    });
    await ctx.chatApp.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        user: "thread-A",
        messages: [
          ...messagesA1,
          { role: "assistant", content: "A answer 1" },
          { role: "user", content: "A turn 2" },
          { role: "assistant", content: "A answer 2" },
          { role: "user", content: "A turn 3" },
        ],
      }),
    });

    const requests = getCapturedCodexRequests();
    expect(requests).toHaveLength(5);
    expect(requests.map((req) => req.prompt_cache_key)).toEqual([
      "thread-A",
      "thread-B",
      "thread-A",
      "thread-B",
      "thread-A",
    ]);
    expect(requests.map((req) => req.previous_response_id)).toEqual([
      undefined,
      undefined,
      "resp-1",
      "resp-2",
      "resp-3",
    ]);
    expect(requests.map((req) => req.input)).toEqual([
      [{ role: "user", content: "A turn 1" }],
      [{ role: "user", content: "B turn 1" }],
      [{ role: "user", content: "A turn 2" }],
      [{ role: "user", content: "B turn 2" }],
      [{ role: "user", content: "A turn 3" }],
    ]);
  });
});
