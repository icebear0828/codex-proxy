import { describe, it, expect } from "vitest";
import { PreviousResponseWebSocketError } from "@src/proxy/codex-api.js";
import {
  shouldActivateImplicitResume,
  shouldReplayFullInputAfterImplicitResumeError,
} from "@src/routes/shared/proxy-handler.js";

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
});
