import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Config is mocked so the tests can flip the guard on and off without touching
 * the real config loader. `enabled: false` is the shipped default, so most
 * assertions below use explicit option lists to exercise the pure matcher.
 */
const guardConfig = {
  enabled: true,
  error_codes: ["cyber_policy", "session_blocked_by_cyber_policy"],
  message_patterns: [
    "possible cybersecurity risk",
    "high-risk cyber activity",
    "cyber-security policy",
    "网络安全策略屏蔽",
  ],
  status_codes: [] as number[],
  ttl_seconds: 3600,
};

let configThrows = false;

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => {
    if (configThrows) throw new Error("config unavailable");
    return { policy_guard: guardConfig };
  }),
}));

const {
  matchesPolicyRejection,
  isPolicyRejection,
  extractPolicyErrorCode,
  normalizePolicyText,
  policyRejectionSignature,
} = await import("@src/proxy/policy-rejection.js");

const SUB2API_MESSAGE =
  "该会话已被网络安全策略屏蔽，请开启新会话 / This session is blocked by cyber-security policy, please start a new session";

function errorLike(status: number, body: string): { status: number; body: string; message: string } {
  return { status, body, message: body };
}

beforeEach(() => {
  guardConfig.enabled = true;
  guardConfig.status_codes = [];
  configThrows = false;
});

describe("extractPolicyErrorCode", () => {
  it("reads error.code from an HTTP-shaped body", () => {
    expect(extractPolicyErrorCode(JSON.stringify({ error: { code: "cyber_policy" } })))
      .toBe("cyber_policy");
  });

  it("reads a code nested under response.error", () => {
    expect(extractPolicyErrorCode(JSON.stringify({ response: { error: { code: "session_blocked_by_cyber_policy" } } })))
      .toBe("session_blocked_by_cyber_policy");
  });

  it("falls back to error.type when no code is present", () => {
    expect(extractPolicyErrorCode(JSON.stringify({ error: { type: "permission_error" } })))
      .toBe("permission_error");
  });

  it("returns undefined for a non-JSON body", () => {
    expect(extractPolicyErrorCode("<html>Just a moment</html>")).toBeUndefined();
  });
});

describe("matchesPolicyRejection — structured code", () => {
  // The whole point of matching the code first: the same verdict arrives under
  // every status depending on the relay and transport, so keying on status is
  // what let these slip into the retry/rotation paths before.
  for (const status of [400, 403, 429, 500, 502, 503]) {
    it(`matches cyber_policy carried by status ${status}`, () => {
      const err = errorLike(status, JSON.stringify({
        error: { type: "invalid_request_error", code: "cyber_policy", message: "Rejected" },
      }));
      expect(matchesPolicyRejection(err)).toBe(true);
    });
  }

  it("matches the relay's own session-block code", () => {
    const err = errorLike(502, JSON.stringify({
      error: { type: "permission_error", code: "session_blocked_by_cyber_policy", message: SUB2API_MESSAGE },
    }));
    expect(matchesPolicyRejection(err)).toBe(true);
  });

  it("matches a code supplied directly on the error object", () => {
    expect(matchesPolicyRejection({ status: 0, body: "", message: "", code: "cyber_policy" }))
      .toBe(true);
  });
});

describe("matchesPolicyRejection — text fallback", () => {
  it("matches OpenAI's own wording when the code was stripped", () => {
    const err = errorLike(400, JSON.stringify({
      error: { type: "invalid_request_error", message: "This request has been flagged for possible cybersecurity risk." },
    }));
    expect(matchesPolicyRejection(err)).toBe(true);
  });

  it("matches the relay's bilingual template", () => {
    const err = errorLike(502, JSON.stringify({ error: { message: SUB2API_MESSAGE } }));
    expect(matchesPolicyRejection(err)).toBe(true);
  });

  it("matches when the code is stringified into the message text", () => {
    // Some paths build `new Error("Codex API error: <code>: <message>")`, so the
    // code never appears as a field.
    const err = errorLike(502, "");
    err.message = `Codex API error: session_blocked_by_cyber_policy: ${SUB2API_MESSAGE}`;
    expect(matchesPolicyRejection(err)).toBe(true);
  });
});

describe("matchesPolicyRejection — must not fire on ordinary failures", () => {
  it("ignores a plain 429 rate limit", () => {
    const err = errorLike(429, JSON.stringify({
      error: { type: "rate_limit_error", message: "Rate limit reached", resets_in_seconds: 30 },
    }));
    expect(matchesPolicyRejection(err)).toBe(false);
  });

  it("ignores a 503 capacity error", () => {
    const err = errorLike(503, JSON.stringify({
      error: { code: "server_is_overloaded", message: "Server is overloaded" },
    }));
    expect(matchesPolicyRejection(err)).toBe(false);
  });

  it("ignores a Cloudflare challenge body", () => {
    expect(matchesPolicyRejection(errorLike(403, "<html>Just a moment</html>"))).toBe(false);
  });

  it("does not match a request that merely discusses security topics", () => {
    // The matcher only ever sees upstream *error output*; a normal error whose
    // text happens to mention security must not be treated as a rejection.
    const err = errorLike(400, JSON.stringify({
      error: { code: "invalid_request_error", message: "Unsupported parameter: security_policy" },
    }));
    expect(matchesPolicyRejection(err)).toBe(false);
  });

  it("ignores non-object input", () => {
    expect(matchesPolicyRejection(null)).toBe(false);
    expect(matchesPolicyRejection("cyber_policy")).toBe(false);
  });
});

describe("isPolicyRejection — config gate", () => {
  const rejection = errorLike(502, JSON.stringify({
    error: { code: "cyber_policy", message: "Rejected" },
  }));

  it("is inert while the guard is disabled (the shipped default)", () => {
    guardConfig.enabled = false;
    expect(isPolicyRejection(rejection)).toBe(false);
  });

  it("matches once enabled", () => {
    expect(isPolicyRejection(rejection)).toBe(true);
  });

  it("fails closed to disabled when config cannot be read", () => {
    configThrows = true;
    expect(isPolicyRejection(rejection)).toBe(false);
  });
});

describe("matchesPolicyRejection — status narrowing filter", () => {
  const rejection = errorLike(502, JSON.stringify({
    error: { code: "cyber_policy", message: "Rejected" },
  }));

  it("does not restrict when the list is empty (the default)", () => {
    expect(matchesPolicyRejection(rejection, { statusCodes: [] })).toBe(true);
  });

  it("keeps a match whose status is listed", () => {
    expect(matchesPolicyRejection(rejection, { statusCodes: [502, 503] })).toBe(true);
  });

  it("drops a match whose status is not listed", () => {
    expect(matchesPolicyRejection(rejection, { statusCodes: [400] })).toBe(false);
  });

  it("never lets a listed status trigger a match on its own", () => {
    // The safety property: the filter can only narrow. A 403 with an ordinary
    // ban body must stay a ban even when 403 is listed.
    const ban = errorLike(403, JSON.stringify({ detail: "Account suspended" }));
    expect(matchesPolicyRejection(ban, { statusCodes: [403] })).toBe(false);
  });

  it("skips the filter when no status is present", () => {
    // Stream terminal frames carry no HTTP status; filtering them out would
    // silently disable detection on that path.
    expect(matchesPolicyRejection({ code: "cyber_policy", message: "Rejected" }, { statusCodes: [400] }))
      .toBe(true);
  });

  it("applies the configured list through isPolicyRejection", () => {
    guardConfig.status_codes = [400];
    expect(isPolicyRejection(rejection)).toBe(false);
    guardConfig.status_codes = [502];
    expect(isPolicyRejection(rejection)).toBe(true);
  });
});

describe("normalizePolicyText / policyRejectionSignature", () => {
  it("normalizes case and whitespace", () => {
    expect(normalizePolicyText("  Cyber-Security   POLICY\n")).toBe("cyber-security policy");
  });

  it("produces a stable signature that does not embed the message", () => {
    const input = { status: 502, code: "cyber_policy", message: SUB2API_MESSAGE };
    const a = policyRejectionSignature(input);
    const b = policyRejectionSignature({ ...input, message: `  ${SUB2API_MESSAGE}  ` });
    expect(a).toBe(b);
    expect(a).not.toContain("网络安全策略屏蔽");
  });
});
