import { createHash, randomBytes } from "crypto";
import { withFetchDispatcher } from "../proxy/fetch-dispatcher.js";
import {
  ANTIGRAVITY_DEFAULT_OAUTH_CLIENT_ID,
  ANTIGRAVITY_DEFAULT_OAUTH_CLIENT_SECRET,
  ANTIGRAVITY_OAUTH_TOKEN_URL,
} from "../proxy/antigravity-upstream.js";
import { isRecord } from "../translation/shared-utils.js";

const AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const REDIRECT_URI = "http://localhost:51121/oauth-callback";
const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];
const SESSION_TTL_MS = 10 * 60 * 1000;

interface PendingAntigravitySession {
  codeVerifier: string;
  createdAt: number;
  exchanging: boolean;
}

const pendingSessions = new Map<string, PendingAntigravitySession>();

function pruneExpiredSessions(now = Date.now()): void {
  for (const [state, session] of pendingSessions) {
    if (now - session.createdAt > SESSION_TTL_MS) pendingSessions.delete(state);
  }
}

function randomCode(): string {
  return randomBytes(32).toString("base64url");
}

export function startAntigravityOAuthFlow(): string {
  pruneExpiredSessions();

  const state = randomCode();
  const codeVerifier = randomCode();
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const params = new URLSearchParams({
    client_id: process.env.ANTIGRAVITY_OAUTH_CLIENT_ID?.trim() || ANTIGRAVITY_DEFAULT_OAUTH_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPES.join(" "),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
  });

  pendingSessions.set(state, { codeVerifier, createdAt: Date.now(), exchanging: false });
  return `${AUTHORIZATION_URL}?${params.toString()}`;
}

export async function exchangeAntigravityCallback(callback: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(callback.trim());
  } catch {
    throw new Error("Paste the full URL from the browser address bar after Google sign-in.");
  }

  if (url.protocol !== "http:" || url.hostname !== "localhost" || url.port !== "51121" || url.pathname !== "/oauth-callback") {
    throw new Error("The pasted URL is not the Antigravity OAuth callback. Copy the full localhost:51121 URL after sign-in.");
  }

  const error = url.searchParams.get("error");
  if (error) {
    throw new Error(url.searchParams.get("error_description") || `Google OAuth failed: ${error}`);
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) throw new Error("The callback URL must include both code and state.");

  pruneExpiredSessions();
  const session = pendingSessions.get(state);
  if (!session) throw new Error("This Antigravity login session expired or does not match. Generate a new login link.");
  if (session.exchanging) throw new Error("This Antigravity authorization code is already being exchanged.");
  session.exchanging = true;

  const form = new URLSearchParams({
    client_id: process.env.ANTIGRAVITY_OAUTH_CLIENT_ID?.trim() || ANTIGRAVITY_DEFAULT_OAUTH_CLIENT_ID,
    client_secret: process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET?.trim() || ANTIGRAVITY_DEFAULT_OAUTH_CLIENT_SECRET,
    code,
    code_verifier: session.codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: REDIRECT_URI,
  });

  try {
    const response = await fetch(ANTIGRAVITY_OAUTH_TOKEN_URL, withFetchDispatcher({
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: form.toString(),
      signal: AbortSignal.timeout(15_000),
    }));
    const data: unknown = await response.json().catch(() => null);
    pendingSessions.delete(state);

    if (!response.ok || !isRecord(data)) {
      const detail = isRecord(data) && typeof data.error_description === "string"
        ? data.error_description
        : `Google OAuth code exchange failed (HTTP ${response.status}). Generate a new login link and try again.`;
      throw new Error(detail);
    }
    if (typeof data.refresh_token !== "string" || !data.refresh_token.trim()) {
      throw new Error("Google did not return a refresh token. Generate a new login link and approve access again.");
    }
    return data.refresh_token;
  } catch (error) {
    if (pendingSessions.get(state) === session) session.exchanging = false;
    throw error;
  }
}
