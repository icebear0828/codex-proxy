import { createHash, randomBytes } from "crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { withFetchDispatcher } from "../proxy/fetch-dispatcher.js";
import {
  ANTIGRAVITY_DEFAULT_OAUTH_CLIENT_ID,
  ANTIGRAVITY_DEFAULT_OAUTH_CLIENT_SECRET,
  ANTIGRAVITY_OAUTH_TOKEN_URL,
} from "../proxy/antigravity-upstream.js";
import { isRecord } from "../translation/shared-utils.js";

const AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const CALLBACK_PORT = 51121;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/oauth-callback`;
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
let callbackServer: Server | null = null;
let callbackServerTimeout: ReturnType<typeof setTimeout> | null = null;

function closeCallbackServer(server: Server | null = callbackServer): void {
  if (!server || callbackServer !== server) return;
  callbackServer = null;
  if (callbackServerTimeout) clearTimeout(callbackServerTimeout);
  callbackServerTimeout = null;
  if (server.listening) server.close();
}

function sendCallbackPage(response: ServerResponse): void {
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    "Content-Type": "text/html; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(`<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Antigravity OAuth</title>
<style>body{font:16px system-ui,sans-serif;max-width:560px;margin:12vh auto;padding:24px;color:#172033}h1{font-size:24px}p{line-height:1.6;color:#526078}input{box-sizing:border-box;width:100%;padding:12px;border:1px solid #ccd3df;border-radius:8px}button{margin-top:12px;padding:10px 14px;border:0;border-radius:8px;background:#315efb;color:white;cursor:pointer}</style>
<main><h1>Antigravity 登录完成</h1><p id="message">正在返回 Codex Proxy…</p><input id="callback" aria-label="回调地址" readonly><button id="copy" hidden>复制回调地址</button></main>
<script>
const callbackUrl = window.location.href;
const input = document.getElementById('callback');
input.value = callbackUrl;
const isError = new URLSearchParams(window.location.search).has('error');
if (isError) document.getElementById('message').textContent = '登录未完成，正在返回 Codex Proxy…';
if (window.opener) {
  window.opener.postMessage({ type: 'antigravity-oauth-callback', callbackUrl }, '*');
  setTimeout(() => window.close(), 300);
} else {
  document.getElementById('message').textContent = '请复制下面的完整地址，并粘贴回 Codex Proxy。';
  document.getElementById('copy').hidden = false;
  document.getElementById('copy').onclick = async () => { await navigator.clipboard.writeText(callbackUrl); document.getElementById('copy').textContent = '已复制'; };
  input.select();
}
</script></html>`);
}

async function ensureCallbackServer(): Promise<void> {
  if (callbackServer?.listening) {
    if (callbackServerTimeout) clearTimeout(callbackServerTimeout);
    callbackServerTimeout = setTimeout(() => closeCallbackServer(), SESSION_TTL_MS);
    callbackServerTimeout.unref();
    return;
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://localhost");
    if (request.method !== "GET" || url.pathname !== "/oauth-callback") {
      response.writeHead(404, { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    const state = url.searchParams.get("state");
    if (!state || !pendingSessions.has(state)) {
      response.writeHead(400, { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" });
      response.end("This Antigravity login session is invalid or expired. Return to Codex Proxy and start again.");
      return;
    }
    sendCallbackPage(response);
    response.once("finish", () => closeCallbackServer(server));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(CALLBACK_PORT, "localhost", () => {
      server.off("error", onError);
      resolve();
    });
  });

  callbackServer = server;
  callbackServerTimeout = setTimeout(() => closeCallbackServer(server), SESSION_TTL_MS);
  callbackServerTimeout.unref();
}

function pruneExpiredSessions(now = Date.now()): void {
  for (const [state, session] of pendingSessions) {
    if (now - session.createdAt > SESSION_TTL_MS) pendingSessions.delete(state);
  }
}

function randomCode(): string {
  return randomBytes(32).toString("base64url");
}

export async function startAntigravityOAuthFlow(): Promise<string> {
  pruneExpiredSessions();
  await ensureCallbackServer();

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
