import { describe, it, expect } from "vitest";
import { PreviousResponseWebSocketError } from "@src/proxy/codex-api.js";
import type { CodexResponsesRequest } from "@src/proxy/codex-api.js";
import {
  evaluateImplicitResume,
  resolvePromptCacheIdentity,
  shouldActivateImplicitResume,
  shouldReplayFullInputAfterImplicitResumeError,
} from "@src/routes/shared/proxy-session-helpers.js";

function makeCodexRequest(overrides: Partial<CodexResponsesRequest> = {}): CodexResponsesRequest {
  return {
    model: "gpt-5.4",
    input: [{ role: "user", content: "first message" }],
    stream: true,
    store: false,
    instructions: "system prompt",
    ...overrides,
  };
}

describe("resolvePromptCacheIdentity", () => {
  it("显式 prompt_cache_key 优先于 Claude Code session 和内容 hash", () => {
    const result = resolvePromptCacheIdentity(
      makeCodexRequest({ prompt_cache_key: " explicit-thread " }),
      "claude-session",
      () => "fallback-thread",
    );

    expect(result.promptCacheKey).toBe("explicit-thread");
    expect(result.conversationId).toBe("explicit-thread");
  });

  it("Claude Code session id 优先于内容 hash，避免同 session 被首条消息拆成多个 key", () => {
    const firstTurn = makeCodexRequest({
      input: [{ role: "user", content: "first task" }],
    });
    const laterTurnWithDifferentAnchor = makeCodexRequest({
      input: [
        { role: "user", content: "different internal task" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "continue" },
      ],
      tools: [{ type: "function", name: "read_file" }],
    });

    expect(resolvePromptCacheIdentity(firstTurn, "claude-session").promptCacheKey).toBe("claude-session");
    expect(resolvePromptCacheIdentity(laterTurnWithDifferentAnchor, "claude-session").promptCacheKey).toBe("claude-session");
  });

  it("没有显式 key 或 session id 时回退到稳定内容 hash", () => {
    const result = resolvePromptCacheIdentity(makeCodexRequest(), undefined, () => "fallback-thread");

    expect(result.promptCacheKey).not.toBe("fallback-thread");
    expect(result.promptCacheKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("空字符串 key/session 被忽略，避免退化成共享空会话", () => {
    const result = resolvePromptCacheIdentity(
      makeCodexRequest({ prompt_cache_key: " " }),
      "",
      () => "fallback-thread",
    );

    expect(result.promptCacheKey).not.toBe("");
    expect(result.promptCacheKey).not.toBe("fallback-thread");
  });
});

describe("shouldActivateImplicitResume", () => {
  it("同账号且 system 未变化时允许隐式续链", () => {
    expect(shouldActivateImplicitResume({
      implicitPrevRespId: "resp_prev",
      continuationInputStart: 2,
      inputLength: 3,
      preferredEntryId: "entry_1",
      acquiredEntryId: "entry_1",
      currentInstructions: "system-a",
      storedInstructions: "system-a",
    })).toBe(true);
  });

  it("system 变化时禁止隐式续链", () => {
    expect(shouldActivateImplicitResume({
      implicitPrevRespId: "resp_prev",
      continuationInputStart: 2,
      inputLength: 3,
      preferredEntryId: "entry_1",
      acquiredEntryId: "entry_1",
      currentInstructions: "system-b",
      storedInstructions: "system-a",
    })).toBe(false);
  });

  it("回退到非 affinity 账号时禁止隐式续链", () => {
    expect(shouldActivateImplicitResume({
      implicitPrevRespId: "resp_prev",
      continuationInputStart: 2,
      inputLength: 3,
      preferredEntryId: "entry_1",
      acquiredEntryId: "entry_2",
      currentInstructions: "system-a",
      storedInstructions: "system-a",
    })).toBe(false);
  });

  it("tool_result 与上一轮 function_call 完全配对时允许隐式续链", () => {
    expect(shouldActivateImplicitResume({
      implicitPrevRespId: "resp_prev",
      continuationInputStart: 2,
      inputLength: 3,
      preferredEntryId: "entry_1",
      acquiredEntryId: "entry_1",
      currentInstructions: "system-a",
      storedInstructions: "system-a",
      requiredFunctionCallOutputIds: ["call_a", "call_b"],
      storedFunctionCallIds: ["call_a", "call_b"],
    })).toBe(true);
  });

  it("tool_result 里的 call_id 不属于上一轮 response 时禁止隐式续链", () => {
    expect(shouldActivateImplicitResume({
      implicitPrevRespId: "resp_prev",
      continuationInputStart: 2,
      inputLength: 3,
      preferredEntryId: "entry_1",
      acquiredEntryId: "entry_1",
      currentInstructions: "system-a",
      storedInstructions: "system-a",
      requiredFunctionCallOutputIds: ["call_missing"],
      storedFunctionCallIds: ["call_ok"],
    })).toBe(false);
  });

  it("上一轮 function_call 未被全部回复时禁止隐式续链（防 No tool output 上游错误）", () => {
    expect(shouldActivateImplicitResume({
      implicitPrevRespId: "resp_prev",
      continuationInputStart: 2,
      inputLength: 3,
      preferredEntryId: "entry_1",
      acquiredEntryId: "entry_1",
      currentInstructions: "system-a",
      storedInstructions: "system-a",
      requiredFunctionCallOutputIds: ["call_a"],
      storedFunctionCallIds: ["call_a", "call_b_unanswered"],
    })).toBe(false);
  });

  it("隐式续链 WebSocket 失败时会触发完整历史重放", () => {
    const err = new PreviousResponseWebSocketError("ws down");
    expect(shouldReplayFullInputAfterImplicitResumeError(err, true)).toBe(true);
    expect(shouldReplayFullInputAfterImplicitResumeError(err, false)).toBe(false);
  });

  it("client 主动发自包含 full replay（function_call 与 function_call_output 都在 input 内）时返回 self_contained_replay，不报 missing_tool_calls", () => {
    const result = evaluateImplicitResume({
      implicitPrevRespId: "resp_prev_stale",
      continuationInputStart: 2,
      inputLength: 100,
      preferredEntryId: "entry_1",
      acquiredEntryId: "entry_1",
      currentInstructions: "system-a",
      storedInstructions: "system-a",
      // tool_outputs in input reference call_ids that don't exist in storage
      // (proxy was restarted / session-affinity lost them), but they ARE
      // present inline in the same input → self-contained replay.
      requiredFunctionCallOutputIds: ["call_inlined_a", "call_inlined_b"],
      storedFunctionCallIds: [],
      inlineFunctionCallIds: ["call_inlined_a", "call_inlined_b"],
    });
    expect(result.active).toBe(false);
    expect(result.reason).toBe("self_contained_replay");
  });

  it("混合场景：部分 call_id 在 input 内 inline、部分既不在 input 也不在 storage → 仍判 missing_tool_calls", () => {
    const result = evaluateImplicitResume({
      implicitPrevRespId: "resp_prev",
      continuationInputStart: 2,
      inputLength: 50,
      preferredEntryId: "entry_1",
      acquiredEntryId: "entry_1",
      currentInstructions: "system-a",
      storedInstructions: "system-a",
      requiredFunctionCallOutputIds: ["call_inlined", "call_truly_missing"],
      storedFunctionCallIds: [],
      inlineFunctionCallIds: ["call_inlined"],
    });
    expect(result.active).toBe(false);
    expect(result.reason).toBe("missing_tool_calls");
  });

  it("self_contained_replay 优先于 missing_tool_calls：所有 tool_output 都能在 input 找到对应 function_call 时不应误报 missing", () => {
    const result = evaluateImplicitResume({
      implicitPrevRespId: "resp_prev",
      continuationInputStart: 50,
      inputLength: 102,
      preferredEntryId: "entry_1",
      acquiredEntryId: "entry_1",
      currentInstructions: "system-a",
      storedInstructions: "system-a",
      requiredFunctionCallOutputIds: ["call_x"],
      storedFunctionCallIds: ["call_unrelated_stored"],
      inlineFunctionCallIds: ["call_x", "call_y"],
    });
    expect(result.reason).toBe("self_contained_replay");
  });
});

describe("getInlineFunctionCallIds / isSelfContainedReplay", () => {
  it("getInlineFunctionCallIds 只挑 function_call 项的 call_id，跳过 user/assistant/function_call_output", async () => {
    const { getInlineFunctionCallIds } = await import("@src/routes/shared/proxy-session-helpers.js");
    const ids = getInlineFunctionCallIds([
      { role: "user", content: "hi" },
      { type: "function_call", call_id: "call_a", name: "read", arguments: "{}" },
      { type: "function_call_output", call_id: "call_a", output: "{}" },
      { role: "assistant", content: "ok" },
      { type: "function_call", call_id: "call_b", name: "write", arguments: "{}" },
    ]);
    expect(ids).toEqual(["call_a", "call_b"]);
  });

  it("isSelfContainedReplay 在所有 function_call_output 都能在 input 找到 function_call 配对时返回 true", async () => {
    const { isSelfContainedReplay } = await import("@src/routes/shared/proxy-session-helpers.js");
    expect(isSelfContainedReplay([
      { type: "function_call", call_id: "c1", name: "x", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "{}" },
      { type: "function_call", call_id: "c2", name: "y", arguments: "{}" },
      { type: "function_call_output", call_id: "c2", output: "{}" },
    ])).toBe(true);
  });

  it("isSelfContainedReplay 在 function_call_output 找不到 inline function_call 时返回 false", async () => {
    const { isSelfContainedReplay } = await import("@src/routes/shared/proxy-session-helpers.js");
    expect(isSelfContainedReplay([
      { type: "function_call_output", call_id: "c_orphan", output: "{}" },
    ])).toBe(false);
  });

  it("isSelfContainedReplay 在没有 function_call_output 时返回 false（incremental turn 不是 replay）", async () => {
    const { isSelfContainedReplay } = await import("@src/routes/shared/proxy-session-helpers.js");
    expect(isSelfContainedReplay([
      { role: "user", content: "hi" },
      { type: "function_call", call_id: "c1", name: "x", arguments: "{}" },
    ])).toBe(false);
  });
});
