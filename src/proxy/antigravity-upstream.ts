import { createHash, randomUUID } from "crypto";
import type { UpstreamAdapter } from "./upstream-adapter.js";
import type { CodexResponsesRequest, CodexSSEEvent } from "./codex-types.js";
import { CodexApiError } from "./codex-types.js";
import { classifyRawUpstreamError } from "./error-classification.js";
import { GeminiUpstream } from "./gemini-upstream.js";
import { withFetchDispatcher } from "./fetch-dispatcher.js";
import { translateCodexToGeminiRequest } from "../translation/codex-request-to-gemini.js";
import { isRecord } from "../translation/shared-utils.js";

export const ANTIGRAVITY_DEFAULT_OAUTH_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
export const ANTIGRAVITY_DEFAULT_OAUTH_CLIENT_SECRET = "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";
export const ANTIGRAVITY_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const TOKEN_URL = ANTIGRAVITY_OAUTH_TOKEN_URL;
const DEFAULT_BASE_URL = "https://cloudcode-pa.googleapis.com";
const DAILY_BASE_URL = "https://daily-cloudcode-pa.googleapis.com";
const DEFAULT_USER_AGENT_VERSION = "2.9.1";
const IDENTITY_INSTRUCTION = "You are Antigravity, an AI coding assistant.";
const CODEX_MODEL_IDENTITY = /^\s*You are Codex, a coding agent based on GPT-\d+(?:\.\d+)*\.?\s*/i;
const CLAUDE_CODE_IDENTITY = /^\s*You are Claude Code, Anthropic['’]s official CLI for Claude\.?([ \t\r\n]*)/i;
const CLAUDE_AGENT_IDENTITY = /^\s*You are a Claude agent, built on Anthropic['’]s Claude Agent SDK\.?([ \t\r\n]*)/i;

function normalizeSystemIdentity(text: string): string {
  return text
    .replace(CODEX_MODEL_IDENTITY, "")
    .replace(CLAUDE_CODE_IDENTITY, "You are an AI agent.$1")
    .replace(CLAUDE_AGENT_IDENTITY, "You are an AI agent.$1")
    .trimStart();
}

function sessionId(req: CodexResponsesRequest): string {
  const firstUserMessage = req.input.find((item) => "role" in item && item.role === "user");
  const firstUserText = firstUserMessage
    ? typeof firstUserMessage.content === "string"
      ? firstUserMessage.content
      : firstUserMessage.content
        .filter((part) => part.type === "input_text")
        .map((part) => part.text)
        .join("\n")
    : "";
  const seed = req.prompt_cache_key?.trim() || firstUserText || randomUUID();
  const sessionNumber = createHash("sha256").update(seed).digest().readBigUInt64BE(0)
    & 0x7fff_ffff_ffff_ffffn;
  return `-${sessionNumber.toString()}`;
}

function modelId(model: string): string {
  const colon = model.indexOf(":");
  return colon > 0 ? model.slice(colon + 1) : model;
}

function projectIdFrom(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const project = value.cloudaicompanionProject;
  if (typeof project === "string" && project.trim()) return project.trim();
  if (!isRecord(project)) return null;
  for (const key of ["projectId", "project_id", "id"]) {
    const candidate = project[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

function tierIdFrom(value: unknown): string | null {
  if (!isRecord(value)) return null;
  for (const key of ["paidTier", "currentTier"]) {
    const tier = value[key];
    if (typeof tier === "string" && tier.trim()) return tier.trim();
    if (isRecord(tier) && typeof tier.id === "string" && tier.id.trim()) return tier.id.trim();
  }
  return null;
}

function isPaidTier(value: unknown): boolean {
  const tierId = tierIdFrom(value)?.toLowerCase();
  return tierId === "g1-pro-tier" || tierId === "g1-ultra-tier";
}

function shouldFallbackCodeAssist(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 404 || statusCode === 429 || statusCode >= 500;
}

export class AntigravityUpstream implements UpstreamAdapter {
  readonly tag = "antigravity";
  private baseUrl: string;
  private readonly baseUrlConfigured: boolean;
  private readonly userAgent: string;
  private readonly streamParser = new GeminiUpstream("", DEFAULT_BASE_URL);
  private accessToken = "";
  private accessTokenExpiresAt = 0;
  private refreshPromise: Promise<string> | null = null;
  private resolvedProjectId: string | null;
  private accountInfoResolved = false;

  constructor(
    private readonly refreshToken: string,
    projectId?: string,
    baseUrl?: string,
  ) {
    this.resolvedProjectId = projectId?.trim() || null;
    const configuredBaseUrl = baseUrl?.trim().replace(/\/+$/, "") ?? "";
    this.baseUrlConfigured = configuredBaseUrl.length > 0;
    this.baseUrl = configuredBaseUrl || DEFAULT_BASE_URL;
    const configuredVersion = process.env.ANTIGRAVITY_USER_AGENT_VERSION?.trim() ?? "";
    const version = /^\d+\.\d+\.\d+$/.test(configuredVersion)
      ? configuredVersion
      : DEFAULT_USER_AGENT_VERSION;
    this.userAgent = `antigravity/${version} windows/amd64`;
  }

  async createResponse(req: CodexResponsesRequest, signal: AbortSignal): Promise<Response> {
    const model = modelId(req.model);
    const geminiRequest = translateCodexToGeminiRequest({
      ...req,
      instructions: typeof req.instructions === "string"
        ? normalizeSystemIdentity(req.instructions)
        : req.instructions,
    });
    const requestPayload: Record<string, unknown> = { ...geminiRequest };
    const systemInstruction = requestPayload.system_instruction;
    delete requestPayload.system_instruction;
    const parts: unknown[] = isRecord(systemInstruction) && Array.isArray(systemInstruction.parts)
      ? systemInstruction.parts
      : [];
    const cleanedParts = parts.map((part) => isRecord(part) && typeof part.text === "string"
      ? { ...part, text: normalizeSystemIdentity(part.text) }
      : part);
    requestPayload.systemInstruction = {
      parts: [{ text: IDENTITY_INSTRUCTION }, ...cleanedParts],
    };
    requestPayload.sessionId = sessionId(req);
    requestPayload.toolConfig = {
      functionCallingConfig: { mode: "VALIDATED" },
    };

    const projectId = await this.getProjectId(signal);
    const requestBody = JSON.stringify({
      project: projectId,
      requestId: `agent-${randomUUID()}`,
      userAgent: "antigravity",
      requestType: "agent",
      model,
      request: requestPayload,
    });
    const response = await this.sendCloudCode("streamGenerateContent", requestBody, signal);
    if (!response.ok) {
      const errorText = await response.text().catch(() => `HTTP ${response.status}`);
      throw new CodexApiError(
        classifyRawUpstreamError(response.status, errorText),
        errorText,
        response.headers,
      );
    }
    return response;
  }

  async *parseStream(response: Response): AsyncGenerator<CodexSSEEvent> {
    yield* this.streamParser.parseStream(response);
  }

  private async getAccessToken(force = false): Promise<string> {
    if (!force && this.accessToken && Date.now() < this.accessTokenExpiresAt - 60_000) {
      return this.accessToken;
    }
    if (force) {
      this.accessToken = "";
      this.accessTokenExpiresAt = 0;
    }
    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshAccessToken().finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  private async refreshAccessToken(): Promise<string> {
    const clientSecret = process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET?.trim() || ANTIGRAVITY_DEFAULT_OAUTH_CLIENT_SECRET;

    const form = new URLSearchParams({
      client_id: process.env.ANTIGRAVITY_OAUTH_CLIENT_ID?.trim() || ANTIGRAVITY_DEFAULT_OAUTH_CLIENT_ID,
      client_secret: clientSecret,
      refresh_token: this.refreshToken,
      grant_type: "refresh_token",
    });
    const response = await fetch(TOKEN_URL, withFetchDispatcher({
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: form.toString(),
      signal: AbortSignal.timeout(15_000),
    }));
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok || !isRecord(data) || typeof data.access_token !== "string") {
      const detail = isRecord(data) && typeof data.error_description === "string"
        ? data.error_description
        : `Google OAuth token refresh failed (HTTP ${response.status})`;
      throw new CodexApiError(response.status || 502, detail, response.headers);
    }

    const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;
    this.accessToken = data.access_token;
    this.accessTokenExpiresAt = Date.now() + Math.max(60, expiresIn) * 1000;
    return this.accessToken;
  }

  private async getProjectId(signal: AbortSignal): Promise<string> {
    if (this.accountInfoResolved && this.resolvedProjectId) return this.resolvedProjectId;
    const body = JSON.stringify({
      metadata: {
        ideType: "ANTIGRAVITY",
        ideVersion: this.userAgent.split("/")[1].split(" ")[0],
        ideName: "antigravity",
      },
    });
    let response: Response;
    try {
      response = await this.loadCodeAssist(body, signal);
    } catch (error) {
      if (this.resolvedProjectId) {
        this.accountInfoResolved = true;
        return this.resolvedProjectId;
      }
      throw error;
    }
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      if (this.resolvedProjectId) {
        this.accountInfoResolved = true;
        return this.resolvedProjectId;
      }
      const detail = isRecord(data) && isRecord(data.error) && typeof data.error.message === "string"
        ? data.error.message
        : `Antigravity project discovery failed (HTTP ${response.status})`;
      throw new CodexApiError(response.status, detail, response.headers);
    }
    this.accountInfoResolved = true;
    if (!this.baseUrlConfigured && isPaidTier(data)) this.baseUrl = DAILY_BASE_URL;
    const discovered = projectIdFrom(data);
    if (discovered) this.resolvedProjectId ??= discovered;
    if (!this.resolvedProjectId) {
      throw new CodexApiError(422, "Antigravity did not return a Cloud Code project. Enter the account's Google project ID in its settings.");
    }
    return this.resolvedProjectId;
  }

  private async loadCodeAssist(body: string, signal: AbortSignal): Promise<Response> {
    const canFallback = !this.baseUrlConfigured && this.baseUrl === DEFAULT_BASE_URL;
    if (!canFallback) return this.sendCloudCode("loadCodeAssist", body, signal);
    try {
      const response = await this.sendCloudCode("loadCodeAssist", body, signal);
      if (response.ok || !shouldFallbackCodeAssist(response.status)) return response;
      await response.body?.cancel().catch(() => undefined);
    } catch (error) {
      if (signal.aborted) throw error;
    }
    return this.sendCloudCode("loadCodeAssist", body, signal, DAILY_BASE_URL);
  }

  private async sendCloudCode(action: string, body: string, signal: AbortSignal, baseUrl = this.baseUrl): Promise<Response> {
    const send = async (accessToken: string) => fetch(
      `${baseUrl}/v1internal:${action}${action === "streamGenerateContent" ? "?alt=sse" : ""}`,
      withFetchDispatcher({
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          Accept: action === "streamGenerateContent" ? "text/event-stream" : "application/json",
          "User-Agent": this.userAgent,
        },
        body,
        signal,
      }),
    );

    let response = await send(await this.getAccessToken());
    if (response.status === 401) {
      if (response.body) await response.body.cancel().catch(() => undefined);
      response = await send(await this.getAccessToken(true));
    }
    return response;
  }
}
