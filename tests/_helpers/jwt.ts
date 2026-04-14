/**
 * JWT factory for tests.
 * Creates tokens that decodeJwtPayload() can parse (alg: "none", no signature).
 */

interface JwtClaims {
  exp?: number;
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string;
    chatgpt_plan_type?: string;
    chatgpt_user_id?: string;
  };
  "https://api.openai.com/profile"?: {
    email?: string;
    chatgpt_plan_type?: string;
    chatgpt_user_id?: string;
  };
  [key: string]: unknown;
}

function base64url(data: string): string {
  return Buffer.from(data, "utf-8")
    .toString("base64url");
}

/**
 * Create a test JWT with given claims.
 * Uses alg: "none" + empty signature — perfectly decodable by decodeJwtPayload().
 */
export function createJwt(claims: JwtClaims = {}): string {
  const header = base64url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const payload = base64url(JSON.stringify(claims));
  return `${header}.${payload}.`;
}

/** Create a valid non-expired JWT with standard Codex claims. */
export function createValidJwt(overrides: {
  accountId?: string;
  /** chatgpt_user_id — team members share accountId but differ by userId */
  userId?: string;
  email?: string;
  planType?: string;
  expInSeconds?: number;
} = {}): string {
  const exp = Math.floor(Date.now() / 1000) + (overrides.expInSeconds ?? 3600);
  return createJwt({
    exp,
    "https://api.openai.com/auth": {
      chatgpt_account_id: overrides.accountId ?? "acct-test-123",
      chatgpt_plan_type: overrides.planType ?? "free",
      ...(overrides.userId !== undefined ? { chatgpt_user_id: overrides.userId } : {}),
    },
    "https://api.openai.com/profile": {
      email: overrides.email ?? "test@example.com",
    },
  });
}

/** Create an expired JWT. */
export function createExpiredJwt(): string {
  return createJwt({
    exp: Math.floor(Date.now() / 1000) - 3600,
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct-expired",
    },
    "https://api.openai.com/profile": {
      email: "expired@example.com",
    },
  });
}
