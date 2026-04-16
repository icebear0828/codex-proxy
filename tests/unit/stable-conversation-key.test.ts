/**
 * 验证 deriveStableConversationKey 的稳定性和正确性。
 *
 * 这个函数是让 Codex 缓存真正工作的关键：
 * 同一对话的所有轮次必须得到相同的 prompt_cache_key，
 * 不同对话必须得到不同的 key。
 */

import { describe, it, expect } from "vitest";
import type { CodexResponsesRequest } from "@src/proxy/codex-types.js";
import { deriveStableConversationKey } from "@src/routes/shared/stable-conversation-key.js";

function makeReq(opts: {
  instructions?: string;
  messages: Array<{ role: "user" | "assistant"; text: string }>;
}): CodexResponsesRequest {
  return {
    model: "gpt-5.4",
    input: opts.messages.map((m) => ({
      role: m.role,
      content: m.text,
    })),
    stream: true as const,
    store: false as const,
    instructions: opts.instructions,
  };
}

// ── 稳定性测试 ────────────────────────────────────────────────────────

describe("deriveStableConversationKey 稳定性", () => {
  it("相同输入 → 相同 key（幂等性）", () => {
    const req = makeReq({
      instructions: "你是一个助手",
      messages: [{ role: "user", text: "你好" }],
    });
    const k1 = deriveStableConversationKey(req);
    const k2 = deriveStableConversationKey(req);
    expect(k1).not.toBeNull();
    expect(k1).toBe(k2);
  });

  it("同一对话多轮次 → key 不变（固定 model + system + 第一条 user 消息）", () => {
    const turn1 = makeReq({
      instructions: "你是代码助手",
      messages: [{ role: "user", text: "帮我写排序" }],
    });
    // 第二轮带上历史
    const turn2 = makeReq({
      instructions: "你是代码助手",
      messages: [
        { role: "user", text: "帮我写排序" },
        { role: "assistant", text: "好的，这是冒泡排序..." },
        { role: "user", text: "换成快排" },
      ],
    });
    // 第三轮更多历史
    const turn3 = makeReq({
      instructions: "你是代码助手",
      messages: [
        { role: "user", text: "帮我写排序" },
        { role: "assistant", text: "好的，这是冒泡排序..." },
        { role: "user", text: "换成快排" },
        { role: "assistant", text: "这是快排实现..." },
        { role: "user", text: "加注释" },
      ],
    });

    const k1 = deriveStableConversationKey(turn1);
    const k2 = deriveStableConversationKey(turn2);
    const k3 = deriveStableConversationKey(turn3);

    expect(k1).toBe(k2);
    expect(k2).toBe(k3);
  });

  it("不同对话（不同第一条消息）→ 不同 key", () => {
    const conv1 = makeReq({
      instructions: "你是助手",
      messages: [{ role: "user", text: "帮我写 Python 代码" }],
    });
    const conv2 = makeReq({
      instructions: "你是助手",
      messages: [{ role: "user", text: "解释量子计算" }],
    });

    const k1 = deriveStableConversationKey(conv1);
    const k2 = deriveStableConversationKey(conv2);
    expect(k1).not.toBe(k2);
  });

  it("相同第一条消息但系统提示不同 → 使用不同 key", () => {
    const req1 = makeReq({
      instructions: "你是 Python 专家",
      messages: [{ role: "user", text: "你好" }],
    });
    const req2 = makeReq({
      instructions: "你是 Rust 专家",
      messages: [{ role: "user", text: "你好" }],
    });

    expect(deriveStableConversationKey(req1)).not.toBe(
      deriveStableConversationKey(req2)
    );
  });

  it("不同模型 → 不同 key（即使第一条消息相同）", () => {
    const req1 = makeReq({
      instructions: "你是助手",
      messages: [{ role: "user", text: "你好" }],
    });
    const req2 = {
      ...req1,
      model: "gpt-5.4-mini",
    } satisfies CodexResponsesRequest;

    expect(deriveStableConversationKey(req1)).not.toBe(
      deriveStableConversationKey(req2)
    );
  });

  it("没有内容时返回 null（降级到随机 UUID）", () => {
    const empty = makeReq({ messages: [] });
    expect(deriveStableConversationKey(empty)).toBeNull();
  });

  it("input 缺失时返回 null，避免测试或异常请求触发 500", () => {
    const req = {
      model: "gpt-5.4",
      stream: true as const,
      store: false as const,
    } as CodexResponsesRequest;
    expect(deriveStableConversationKey(req)).toBeNull();
  });

  it("input 缺失但有 instructions 时仍能生成 key", () => {
    const req = {
      model: "gpt-5.4",
      instructions: "system prompt",
      stream: true as const,
      store: false as const,
    } as CodexResponsesRequest;

    expect(deriveStableConversationKey(req)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("input 不是数组时不抛异常", () => {
    const req = {
      model: "gpt-5.4",
      instructions: "system prompt",
      input: "not-an-array",
      stream: true as const,
      store: false as const,
    } as unknown as CodexResponsesRequest;

    expect(() => deriveStableConversationKey(req)).not.toThrow();
    expect(deriveStableConversationKey(req)).not.toBeNull();
  });

  it("没有 instructions 但有消息时仍能生成 key", () => {
    const req = makeReq({
      messages: [{ role: "user", text: "简单问题" }],
    });
    expect(deriveStableConversationKey(req)).not.toBeNull();
  });
});

// ── 格式测试 ──────────────────────────────────────────────────────────

describe("key 格式", () => {
  it("生成 UUID 格式的字符串", () => {
    const req = makeReq({
      instructions: "system",
      messages: [{ role: "user", text: "hello" }],
    });
    const key = deriveStableConversationKey(req);
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

// ── 关键场景：Claude Code 实际使用方式 ───────────────────────────────

describe("Claude Code 实际场景", () => {
  const CLAUDE_CODE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude. " +
    "You are an interactive agent that helps users with software engineering tasks. ".repeat(5);

  it("Claude Code 多轮对话：所有轮次使用同一个缓存 key", () => {
    // 模拟 Claude Code 实际发送的请求结构
    const firstTurn = makeReq({
      instructions: CLAUDE_CODE_SYSTEM,
      messages: [
        { role: "user", text: "帮我优化这个函数" },
      ],
    });

    const secondTurn = makeReq({
      instructions: CLAUDE_CODE_SYSTEM,
      messages: [
        { role: "user", text: "帮我优化这个函数" },
        { role: "assistant", text: "好的，我来看一下..." },
        { role: "user", text: "能加上类型注解吗" },
      ],
    });

    const thirdTurn = makeReq({
      instructions: CLAUDE_CODE_SYSTEM,
      messages: [
        { role: "user", text: "帮我优化这个函数" },
        { role: "assistant", text: "好的，我来看一下..." },
        { role: "user", text: "能加上类型注解吗" },
        { role: "assistant", text: "加好了..." },
        { role: "user", text: "现在写测试" },
      ],
    });

    const k1 = deriveStableConversationKey(firstTurn);
    const k2 = deriveStableConversationKey(secondTurn);
    const k3 = deriveStableConversationKey(thirdTurn);

    // 所有轮次 key 相同 → Codex 可以命中缓存
    expect(k1).toBe(k2);
    expect(k2).toBe(k3);

    // 确认不是 null
    expect(k1).not.toBeNull();
  });

  it("新的 Claude Code session（新问题）→ 不同 key", () => {
    const session1Turn1 = makeReq({
      instructions: CLAUDE_CODE_SYSTEM,
      messages: [{ role: "user", text: "帮我优化这个函数" }],
    });
    const session2Turn1 = makeReq({
      instructions: CLAUDE_CODE_SYSTEM,
      messages: [{ role: "user", text: "解释这段代码的作用" }],
    });

    expect(deriveStableConversationKey(session1Turn1)).not.toBe(
      deriveStableConversationKey(session2Turn1)
    );
  });

  it("忽略 Claude 注入的 system-reminder 前缀变化", () => {
    const prompt = "帮我优化这个函数，并且只给出最终答案。";
    const turn1 = makeReq({
      instructions: CLAUDE_CODE_SYSTEM,
      messages: [{
        role: "user",
        text:
          "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# currentDate\nToday's date is 2026-04-10\n</system-reminder>\n" +
          prompt,
      }],
    });
    const turn2 = makeReq({
      instructions: CLAUDE_CODE_SYSTEM,
      messages: [
        {
          role: "user",
          text:
            "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# currentDate\nToday's date is 2026-04-11\n# cwd\n/tmp/demo\n</system-reminder>\n" +
            prompt,
        },
        { role: "assistant", text: "ACK-1" },
        { role: "user", text: "继续" },
      ],
    });

    expect(deriveStableConversationKey(turn1)).toBe(
      deriveStableConversationKey(turn2)
    );
  });
});
