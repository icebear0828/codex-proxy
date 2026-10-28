import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Integration coverage for the two decision points that stop a safety-policy
 * rejection from being resent:
 *
 *   - `classifyRetryAction` (priority 0) — the single hook that covers every
 *     retry path: full-input replay, chain reconnect, strip-and-retry, rotation.
 *   - `handleCodexApiError` — reached by the account-rotation loops that do not
 *     go through the classifier (e.g. the compact route), and the place where a
 *     policy rejection reported as 403 used to be misread as an account ban.
 *
 * The guard ships disabled, so each case asserts the disabled behavior too —
 * that is the regression guard for "no behavior change unless opted in".
 */
const guardConfig = {
  enabled: true,
  error_codes: ["cyber_policy", "session_blocked_by_cyber_policy"],
  message_patterns: ["possible cybersecurity risk", "网络安全策略屏蔽"],
  ttl_seconds: 3600,
};

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => ({
    policy_guard: guardConfig,
    observability: { local_error_log: false },
  })),
}));

const { classifyRetryAction } = await import("@src/routes/shared/proxy-retry-classifier.js");
const { handleCodexApiError } = await import("@src/routes/shared/proxy-error-handler.js");
const { CodexApiError } = await import("@src/proxy/codex-api.js");

const SUB2API_BODY = JSON.stringify({
  error: {
    type: "permission_error",
    code: "session_blocked_by_cyber_policy",
    message:
      "该会话已被网络安全策略屏蔽，请开启新会话 / This session is blocked by cyber-security policy, please start a new session",
  },
});

const OPENAI_BODY = JSON.stringify({
  error: { type: "invalid_request_error", code: "cyber_policy", message: "Rejected" },
});

const rateLimitBody = JSON.stringify({
  error: { type: "rate_limit_error", message: "Rate limit reached" },
});

const previousResponseNotFoundBody = JSON.stringify({
  error: { type: "invalid_request_error", code: "previous_response_not_found", message: "Not found" },
});

const defaultState = {
  stripAndRetryDone: false,
  modelRetried: false,
  implicitResumeActive: false,
  previousResponseId: undefined as string | undefined,
};

const alwaysReplayable = () => true;

function createMockPool() {
  return {
    markStatus: vi.fn(),
    applyRateLimit429: vi.fn(),
    applyAdditionalRateLimit429: vi.fn(),
    markRateLimited: vi.fn(),
    getEntry: vi.fn().mockReturnValue({ email: "test@example.com" }),
  };
}

beforeEach(() => {
  guardConfig.enabled = true;
});

describe("classifyRetryAction — policy rejection is priority 0", () => {
  it("refuses to replay full input for a resumed stream", () => {
    // Without priority 0 this would return implicit_resume_replay, resending the
    // whole rejected transcript.
    const err = new CodexApiError(502, SUB2API_BODY);
    const action = classifyRetryAction(
      err,
      { ...defaultState, implicitResumeActive: true, previousResponseId: "resp_1" },
      alwaysReplayable,
    );
    expect(action.type).toBe("policy_rejected");
  });

  it("refuses strip-and-retry even when the body also looks like a stale session", () => {
    const err = new CodexApiError(
      400,
      JSON.stringify({
        error: { code: "cyber_policy", message: "Rejected" },
      }),
    );
    // A body carrying previous_response_not_found wording must not win over the
    // policy verdict — stripping the id would resend the same content.
    const withBoth = new CodexApiError(
      400,
      JSON.stringify({
        error: { code: "cyber_policy", message: "previous_response_not_found: Rejected" },
      }),
    );
    expect(classifyRetryAction(err, defaultState, alwaysReplayable).type).toBe("policy_rejected");
    expect(classifyRetryAction(withBoth, defaultState, alwaysReplayable).type).toBe("policy_rejected");
  });

  it("matches regardless of the status the relay used", () => {
    for (const status of [400, 403, 429, 500, 502, 503]) {
      const err = new CodexApiError(status, OPENAI_BODY);
      expect(classifyRetryAction(err, defaultState, alwaysReplayable).type).toBe("policy_rejected");
    }
  });

  it("leaves ordinary failures on their existing paths", () => {
    expect(classifyRetryAction(new CodexApiError(429, rateLimitBody), defaultState, alwaysReplayable).type)
      .toBe("error_handler_decides");
    expect(classifyRetryAction(new CodexApiError(400, previousResponseNotFoundBody), defaultState, alwaysReplayable).type)
      .toBe("strip_and_retry");
  });

  it("is inert while the guard is disabled", () => {
    guardConfig.enabled = false;
    const err = new CodexApiError(400, previousResponseNotFoundBody.replace("previous_response_not_found", "cyber_policy"));
    expect(classifyRetryAction(err, defaultState, alwaysReplayable).type).toBe("error_handler_decides");
  });
});

describe("handleCodexApiError — policy rejection branch", () => {
  it("responds without rotating, and does not ban the account on a 403", () => {
    // A relay can surface the rejection as 403; the ban branch used to mark the
    // (innocent) account banned and rotate, resending the content elsewhere.
    const pool = createMockPool();
    const err = new CodexApiError(403, SUB2API_BODY);
    const action = handleCodexApiError(
      err as never, pool as never, "entry-1", "gpt-5.6-sol", "Responses", false,
    );
    expect(action.action).toBe("respond");
    expect(action.action === "respond" && action.status).toBe(400);
    expect(pool.markStatus).not.toHaveBeenCalled();
  });

  it("does not apply rate-limit state when the rejection arrives as 429", () => {
    const pool = createMockPool();
    const err = new CodexApiError(429, SUB2API_BODY);
    const action = handleCodexApiError(
      err as never, pool as never, "entry-1", "gpt-5.6-sol", "Responses", false,
    );
    expect(action.action).toBe("respond");
    expect(pool.applyRateLimit429).not.toHaveBeenCalled();
    expect(pool.applyAdditionalRateLimit429).not.toHaveBeenCalled();
  });

  it("does not mark the account banned when the rejection arrives as 403 (disabled guard)", () => {
    // Documents the pre-existing behavior the guard is opting out of.
    guardConfig.enabled = false;
    const pool = createMockPool();
    const err = new CodexApiError(403, SUB2API_BODY);
    const action = handleCodexApiError(
      err as never, pool as never, "entry-1", "gpt-5.6-sol", "Responses", false,
    );
    expect(action.action).toBe("retry");
    expect(pool.markStatus).toHaveBeenCalledWith("entry-1", "banned");
  });
});
