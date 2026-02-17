import { spawn, type ChildProcess } from "child_process";
import { getConfig } from "../config.js";
import {
  decodeJwtPayload,
  extractChatGptAccountId,
  isTokenExpired,
} from "./jwt-utils.js";

export interface OAuthResult {
  success: boolean;
  token?: string;
  error?: string;
}

const INIT_REQUEST_ID = "__codex-desktop_initialize__";

/**
 * Approach 1: Login via Codex CLI subprocess (JSON-RPC over stdio).
 * Spawns `codex app-server` and uses JSON-RPC to initiate OAuth.
 *
 * Flow:
 *   1. Spawn `codex app-server`
 *   2. Send `initialize` handshake (required before any other request)
 *   3. Send `account/login/start` with type "chatgpt"
 *   4. CLI returns an Auth0 authUrl and starts a local callback server
 *   5. User completes OAuth in browser
 *   6. CLI sends `account/login/completed` notification with token
 */
export async function loginViaCli(): Promise<{
  authUrl: string;
  waitForCompletion: () => Promise<OAuthResult>;
}> {
  const { command, args } = await resolveCliCommand();

  return new Promise((resolveOuter, rejectOuter) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...SPAWN_OPTS,
    });

    let buffer = "";
    let rpcId = 1;
    let authUrl = "";
    let initialized = false;
    let outerResolved = false;
    let awaitingAuthStatus = false;
    const AUTH_STATUS_ID = "__get_auth_status__";

    // Resolvers for the completion promise (token received)
    let resolveCompletion: (result: OAuthResult) => void;
    const completionPromise = new Promise<OAuthResult>((res) => {
      resolveCompletion = res;
    });

    const sendRpc = (
      method: string,
      params: Record<string, unknown> = {},
      id?: string | number,
    ) => {
      const msgId = id ?? rpcId++;
      const msg = JSON.stringify({
        jsonrpc: "2.0",
        id: msgId,
        method,
        params,
      });
      child.stdin.write(msg + "\n");
    };

    // Kill child on completion timeout (5 minutes)
    const killTimer = setTimeout(() => {
      if (!outerResolved) {
        rejectOuter(new Error("OAuth flow timed out (5 minutes)"));
      }
      resolveCompletion({
        success: false,
        error: "OAuth flow timed out",
      });
      child.kill();
    }, 5 * 60 * 1000);

    const cleanup = () => {
      clearTimeout(killTimer);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);

          // Response to initialize request
          if (msg.id === INIT_REQUEST_ID && !initialized) {
            if (msg.error) {
              const errMsg =
                msg.error.message ?? "Failed to initialize app-server";
              cleanup();
              rejectOuter(new Error(errMsg));
              resolveCompletion({ success: false, error: errMsg });
              child.kill();
              return;
            }
            initialized = true;
            console.log(
              "[OAuth] Codex app-server initialized:",
              msg.result?.userAgent ?? "unknown",
            );
            // Now send the login request
            sendRpc("account/login/start", { type: "chatgpt" });
            continue;
          }

          // Response to account/login/start
          if (msg.result && msg.result.authUrl && !outerResolved) {
            authUrl = msg.result.authUrl;
            outerResolved = true;
            console.log(
              "[OAuth] Auth URL received, loginId:",
              msg.result.loginId,
            );
            resolveOuter({
              authUrl,
              waitForCompletion: () => completionPromise,
            });
            continue;
          }

          // Notification: login completed — need to fetch token via getAuthStatus
          if (msg.method === "account/login/completed" && msg.params) {
            const { success, error: loginError } = msg.params;
            console.log("[OAuth] Login completed, success:", success);
            if (success) {
              // Login succeeded but the notification doesn't include the token.
              // We must request it via getAuthStatus.
              awaitingAuthStatus = true;
              sendRpc(
                "getAuthStatus",
                { includeToken: true, refreshToken: false },
                AUTH_STATUS_ID,
              );
            } else {
              cleanup();
              resolveCompletion({
                success: false,
                error: loginError ?? "Login failed",
              });
              child.kill();
            }
            continue;
          }

          // Response to getAuthStatus — extract the token
          if (msg.id === AUTH_STATUS_ID && awaitingAuthStatus) {
            awaitingAuthStatus = false;
            cleanup();
            if (msg.error) {
              resolveCompletion({
                success: false,
                error: msg.error.message ?? "Failed to get auth status",
              });
            } else {
              const authToken = msg.result?.authToken ?? null;
              if (typeof authToken === "string") {
                console.log("[OAuth] Token received successfully");
                resolveCompletion({ success: true, token: authToken });
              } else {
                resolveCompletion({
                  success: false,
                  error: "getAuthStatus returned no token",
                });
              }
            }
            // Give CLI a moment to clean up, then kill
            setTimeout(() => child.kill(), 1000);
            continue;
          }

          // Notification: account/updated (auth status changed)
          if (msg.method === "account/updated" && msg.params) {
            console.log("[OAuth] Account updated:", msg.params.authMode);
            // If we haven't requested auth status yet and auth mode is set,
            // this might be our signal to fetch the token
            if (!awaitingAuthStatus && msg.params.authMode === "chatgpt") {
              awaitingAuthStatus = true;
              sendRpc(
                "getAuthStatus",
                { includeToken: true, refreshToken: false },
                AUTH_STATUS_ID,
              );
            }
            continue;
          }

          // Error response (to our login request)
          if (msg.error && msg.id !== INIT_REQUEST_ID) {
            const errMsg = msg.error.message ?? "Unknown JSON-RPC error";
            cleanup();
            if (!outerResolved) {
              outerResolved = true;
              rejectOuter(new Error(errMsg));
            }
            resolveCompletion({ success: false, error: errMsg });
            child.kill();
          }
        } catch {
          // Skip non-JSON lines (stderr leak, log output, etc.)
        }
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        console.log("[OAuth CLI stderr]", text);
      }
    });

    child.on("error", (err) => {
      const msg = `Failed to spawn Codex CLI: ${err.message}`;
      cleanup();
      if (!outerResolved) {
        outerResolved = true;
        rejectOuter(new Error(msg));
      }
      resolveCompletion({ success: false, error: msg });
    });

    child.on("close", (code) => {
      cleanup();
      if (!outerResolved) {
        outerResolved = true;
        rejectOuter(
          new Error(
            `Codex CLI exited with code ${code} before returning authUrl`,
          ),
        );
      }
      resolveCompletion({
        success: false,
        error: `Codex CLI exited with code ${code}`,
      });
    });

    // Step 1: Send the initialize handshake
    const config = getConfig();
    sendRpc(
      "initialize",
      {
        clientInfo: {
          name: "Codex Desktop",
          title: "Codex Desktop",
          version: config.client.app_version,
        },
      },
      INIT_REQUEST_ID,
    );
  });
}

/**
 * Refresh an existing token via Codex CLI (JSON-RPC).
 * Spawns `codex app-server`, sends `initialize`, then `getAuthStatus` with refreshToken: true.
 * Returns the new token string, or throws on failure.
 */
export async function refreshTokenViaCli(): Promise<string> {
  const { command, args } = await resolveCliCommand();

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...SPAWN_OPTS,
    });

    let buffer = "";
    const AUTH_STATUS_ID = "__refresh_auth_status__";
    let initialized = false;
    let settled = false;

    const killTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("Token refresh timed out (30s)"));
      }
      child.kill();
    }, 30_000);

    const cleanup = () => {
      clearTimeout(killTimer);
    };

    const sendRpc = (
      method: string,
      params: Record<string, unknown> = {},
      id?: string | number,
    ) => {
      const msg = JSON.stringify({
        jsonrpc: "2.0",
        id: id ?? 1,
        method,
        params,
      });
      child.stdin.write(msg + "\n");
    };

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);

          // Response to initialize
          if (msg.id === INIT_REQUEST_ID && !initialized) {
            if (msg.error) {
              cleanup();
              settled = true;
              reject(new Error(msg.error.message ?? "Init failed"));
              child.kill();
              return;
            }
            initialized = true;
            // Request auth status with refresh
            sendRpc(
              "getAuthStatus",
              { includeToken: true, refreshToken: true },
              AUTH_STATUS_ID,
            );
            continue;
          }

          // Response to getAuthStatus
          if (msg.id === AUTH_STATUS_ID) {
            cleanup();
            if (msg.error) {
              settled = true;
              reject(new Error(msg.error.message ?? "getAuthStatus failed"));
            } else {
              const authToken = msg.result?.authToken ?? null;
              if (typeof authToken === "string") {
                settled = true;
                resolve(authToken);
              } else {
                settled = true;
                reject(new Error("getAuthStatus returned no token"));
              }
            }
            setTimeout(() => child.kill(), 500);
            continue;
          }
        } catch {
          // skip non-JSON
        }
      }
    });

    child.stderr?.on("data", () => {});

    child.on("error", (err) => {
      cleanup();
      if (!settled) {
        settled = true;
        reject(new Error(`Failed to spawn Codex CLI: ${err.message}`));
      }
    });

    child.on("close", (code) => {
      cleanup();
      if (!settled) {
        settled = true;
        reject(new Error(`Codex CLI exited with code ${code} during refresh`));
      }
    });

    // Send initialize
    const config = getConfig();
    sendRpc(
      "initialize",
      {
        clientInfo: {
          name: "Codex Desktop",
          title: "Codex Desktop",
          version: config.client.app_version,
        },
      },
      INIT_REQUEST_ID,
    );
  });
}

/**
 * Approach 2: Manual token paste (fallback).
 * Validates a JWT token provided directly by the user.
 */
export function validateManualToken(token: string): {
  valid: boolean;
  error?: string;
} {
  if (!token || typeof token !== "string") {
    return { valid: false, error: "Token is empty" };
  }

  const trimmed = token.trim();
  const payload = decodeJwtPayload(trimmed);
  if (!payload) {
    return {
      valid: false,
      error: "Invalid JWT format — could not decode payload",
    };
  }

  if (isTokenExpired(trimmed)) {
    return { valid: false, error: "Token is expired" };
  }

  const accountId = extractChatGptAccountId(trimmed);
  if (!accountId) {
    return { valid: false, error: "Token missing chatgpt_account_id claim" };
  }

  return { valid: true };
}

/**
 * Check if the Codex CLI is available on the system.
 */
export async function isCodexCliAvailable(): Promise<boolean> {
  try {
    await resolveCliCommand();
    return true;
  } catch {
    return false;
  }
}

// --- private helpers ---

// On Windows, npm-installed binaries (.cmd scripts) require shell: true
const IS_WINDOWS = process.platform === "win32";
const SPAWN_OPTS = IS_WINDOWS ? { shell: true as const } : {};

interface CliCommand {
  command: string;
  args: string[];
}

async function resolveCliCommand(): Promise<CliCommand> {
  // Try `codex` directly first
  if (await testCli("codex", ["--version"])) {
    return { command: "codex", args: ["app-server"] };
  }
  // Fall back to `npx codex`
  if (await testCli("npx", ["codex", "--version"])) {
    return { command: "npx", args: ["codex", "app-server"] };
  }
  throw new Error("Neither 'codex' nor 'npx codex' found in PATH");
}

function testCli(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore", ...SPAWN_OPTS });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}
