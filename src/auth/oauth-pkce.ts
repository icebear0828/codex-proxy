/**
 * Native OAuth PKCE flow for Auth0/OpenAI authentication.
 * Replaces the Codex CLI dependency for login and token refresh.
 */

import { randomBytes, createHash } from "crypto";
import { createServer, type Server } from "http";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";
import { getConfig } from "../config.js";
import { curlFetchPost } from "../tls/curl-fetch.js";

export interface PKCEChallenge {
  codeVerifier: string;
  codeChallenge: string;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type: string;
  expires_in?: number;
}

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

interface PendingSession {
  codeVerifier: string;
  redirectUri: string;
  returnHost: string;
  source: "login" | "dashboard";
  createdAt: number;
}

/** In-memory store for pending OAuth sessions, keyed by `state`. */
const pendingSessions = new Map<string, PendingSession>();

// Clean up expired sessions every 60 seconds
const SESSION_TTL_MS = 5 * 60 * 1000; // 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [state, session] of pendingSessions) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      pendingSessions.delete(state);
    }
  }
}, 60_000).unref();

/**
 * Generate a PKCE code_verifier + code_challenge (S256).
 */
export function generatePKCE(): PKCEChallenge {
  const codeVerifier = randomBytes(32)
    .toString("base64url")
    .replace(/[^a-zA-Z0-9\-._~]/g, "")
    .slice(0, 128);

  const codeChallenge = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");

  return { codeVerifier, codeChallenge };
}

/**
 * Build the Auth0 authorization URL for the PKCE flow.
 */
export function buildAuthUrl(
  redirectUri: string,
  state: string,
  codeChallenge: string,
): string {
  const config = getConfig();
  // Build query string manually — OpenAI's auth server requires %20 for spaces,
  // but URLSearchParams encodes spaces as '+' which causes AuthApiFailure.
  const params: Record<string, string> = {
    response_type: "code",
    client_id: config.auth.oauth_client_id,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "codex_cli_rs",
  };
  const qs = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

  const url = `${config.auth.oauth_auth_endpoint}?${qs}`;
  console.log(`[OAuth] Auth URL: ${url}`);
  return url;
}

/**
 * Exchange an authorization code for tokens.
 */
export async function exchangeCode(
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<TokenResponse> {
  const config = getConfig();

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.auth.oauth_client_id,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });

  const resp = await curlFetchPost(
    config.auth.oauth_token_endpoint,
    "application/x-www-form-urlencoded",
    body.toString(),
  );

  if (!resp.ok) {
    throw new Error(`Token exchange failed (${resp.status}): ${resp.body}`);
  }

  return JSON.parse(resp.body) as TokenResponse;
}

/**
 * Refresh an access token using a refresh_token.
 */
export async function refreshAccessToken(
  refreshToken: string,
): Promise<TokenResponse> {
  const config = getConfig();

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: config.auth.oauth_client_id,
    refresh_token: refreshToken,
  });

  const resp = await curlFetchPost(
    config.auth.oauth_token_endpoint,
    "application/x-www-form-urlencoded",
    body.toString(),
  );

  if (!resp.ok) {
    throw new Error(`Token refresh failed (${resp.status}): ${resp.body}`);
  }

  return JSON.parse(resp.body) as TokenResponse;
}

// ── Pending session management ─────────────────────────────────────

/**
 * OpenAI only whitelists http://localhost:1455/auth/callback for this client_id.
 * The Codex CLI always uses this port — no fallback to random ports.
 */
const OAUTH_CALLBACK_PORT = 1455;

/**
 * Create and store a new pending OAuth session.
 *
 * The redirect_uri is always http://localhost:1455/auth/callback to match
 * the Codex CLI and OpenAI's whitelist. The caller must start a callback
 * server on port 1455 via `startCallbackServer()`.
 */
export function createOAuthSession(
  originalHost: string,
  source: "login" | "dashboard" = "login",
): { state: string; authUrl: string; port: number } {
  const { codeVerifier, codeChallenge } = generatePKCE();
  const state = randomBytes(16).toString("hex");
  const port = OAUTH_CALLBACK_PORT;

  const redirectUri = `http://localhost:${port}/auth/callback`;

  pendingSessions.set(state, {
    codeVerifier,
    redirectUri,
    returnHost: originalHost,
    source,
    createdAt: Date.now(),
  });

  const authUrl = buildAuthUrl(redirectUri, state, codeChallenge);
  return { state, authUrl, port };
}

/**
 * Retrieve and consume a pending session by state.
 * Returns null if not found or expired.
 */
export function consumeSession(
  state: string,
): PendingSession | null {
  const session = pendingSessions.get(state);
  if (!session) return null;

  pendingSessions.delete(state);

  // Check expiry
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    return null;
  }

  return session;
}

// ── Temporary callback server ──────────────────────────────────────

/** Track the active callback server so we can close it before starting a new one. */
let activeCallbackServer: Server | null = null;

/**
 * Start a temporary HTTP server on 0.0.0.0:{port} that handles the OAuth
 * callback (`/auth/callback`). Closes any previously active callback server
 * first (since we always reuse port 1455).
 *
 * Auto-closes after 5 minutes or after a successful callback.
 *
 * @param port      The port from createOAuthSession() (always 1455)
 * @param onAccount Called with (accessToken, refreshToken) on success
 */
export function startCallbackServer(
  port: number,
  onAccount: (accessToken: string, refreshToken: string | undefined) => void,
): Server {
  // Close any existing callback server on this port
  if (activeCallbackServer) {
    try { activeCallbackServer.close(); } catch {}
    activeCallbackServer = null;
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${port}`);

    if (url.pathname !== "/auth/callback") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    const errorDesc = url.searchParams.get("error_description");

    if (error) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(callbackResultHtml(false, errorDesc || error));
      scheduleClose();
      return;
    }

    if (!code || !state) {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end(callbackResultHtml(false, "Missing code or state parameter"));
      scheduleClose();
      return;
    }

    const session = consumeSession(state);
    if (!session) {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end(callbackResultHtml(false, "Invalid or expired session. Please try again."));
      scheduleClose();
      return;
    }

    try {
      const tokens = await exchangeCode(code, session.codeVerifier, session.redirectUri);
      onAccount(tokens.access_token, tokens.refresh_token);
      console.log(`[OAuth] Callback server on port ${port} — login successful`);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(callbackResultHtml(true));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[OAuth] Callback server token exchange failed: ${msg}`);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(callbackResultHtml(false, msg));
    }

    scheduleClose();
  });

  function scheduleClose() {
    setTimeout(() => {
      try { server.close(); } catch {}
      if (activeCallbackServer === server) activeCallbackServer = null;
    }, 2000);
  }

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[OAuth] Port ${port} is in use — callback server not started. Previous login session may still be active.`);
    } else {
      console.error(`[OAuth] Callback server error: ${err.message}`);
    }
  });

  server.listen(port, "0.0.0.0");
  activeCallbackServer = server;
  console.log(`[OAuth] Temporary callback server started on port ${port}`);

  // Auto-close after 5 minutes
  const timeout = setTimeout(() => {
    try { server.close(); } catch {}
    if (activeCallbackServer === server) activeCallbackServer = null;
    console.log(`[OAuth] Temporary callback server on port ${port} timed out`);
  }, 5 * 60 * 1000);
  timeout.unref();

  server.on("close", () => {
    clearTimeout(timeout);
  });

  return server;
}

// ── Device Code Flow (RFC 8628) ────────────────────────────────────

/**
 * Request a device code from Auth0/OpenAI.
 */
export async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const config = getConfig();

  const body = new URLSearchParams({
    client_id: config.auth.oauth_client_id,
    scope: "openid profile email offline_access",
  });

  const resp = await curlFetchPost(
    "https://auth.openai.com/oauth/device/code",
    "application/x-www-form-urlencoded",
    body.toString(),
  );

  if (!resp.ok) {
    throw new Error(`Device code request failed (${resp.status}): ${resp.body}`);
  }

  return JSON.parse(resp.body) as DeviceCodeResponse;
}

/**
 * Poll the token endpoint for a device code authorization.
 * Returns tokens on success, or throws with "authorization_pending" / "slow_down" / other errors.
 */
export async function pollDeviceToken(deviceCode: string): Promise<TokenResponse> {
  const config = getConfig();

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: deviceCode,
    client_id: config.auth.oauth_client_id,
  });

  const resp = await curlFetchPost(
    config.auth.oauth_token_endpoint,
    "application/x-www-form-urlencoded",
    body.toString(),
  );

  if (!resp.ok) {
    const data = JSON.parse(resp.body) as { error?: string; error_description?: string };
    const err = new Error(data.error_description || data.error || `Poll failed (${resp.status})`);
    (err as any).code = data.error;
    throw err;
  }

  return JSON.parse(resp.body) as TokenResponse;
}

// ── CLI Token Import ───────────────────────────────────────────────

export interface CliAuthJson {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_at?: number;
}

/**
 * Read and parse the Codex CLI auth.json file.
 * Path: $CODEX_HOME/auth.json (default: ~/.codex/auth.json)
 */
export function importCliAuth(): CliAuthJson {
  const codexHome = process.env.CODEX_HOME || resolve(homedir(), ".codex");
  const authPath = resolve(codexHome, "auth.json");

  if (!existsSync(authPath)) {
    throw new Error(`CLI auth file not found: ${authPath}`);
  }

  const raw = readFileSync(authPath, "utf-8");
  const data = JSON.parse(raw) as CliAuthJson;

  if (!data.access_token) {
    throw new Error("CLI auth.json does not contain access_token");
  }

  return data;
}

function callbackResultHtml(success: boolean, error?: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  if (success) {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Login Successful</title>
<style>body{font-family:-apple-system,sans-serif;background:#0d1117;color:#c9d1d9;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:2rem;text-align:center;max-width:400px}
h2{color:#3fb950;margin-bottom:1rem}</style></head>
<body><div class="card"><h2>Login Successful</h2><p>You can close this window.</p></div>
<script>
if(window.opener){try{window.opener.postMessage({type:'oauth-callback-success'},'*')}catch(e){}}
try{window.close()}catch{}
</script></body></html>`;
  }

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Login Failed</title>
<style>body{font-family:-apple-system,sans-serif;background:#0d1117;color:#c9d1d9;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:2rem;text-align:center;max-width:400px}
h2{color:#f85149;margin-bottom:1rem}</style></head>
<body><div class="card"><h2>Login Failed</h2><p>${esc(error || "Unknown error")}</p></div>
<script>
if(window.opener){try{window.opener.postMessage({type:'oauth-callback-error',error:${JSON.stringify(error || "Unknown error")}},'*')}catch(e){}}
</script></body></html>`;
}
