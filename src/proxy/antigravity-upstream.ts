import { randomUUID } from "crypto";
import type { UpstreamAdapter } from "./upstream-adapter.js";
import type { CodexResponsesRequest, CodexSSEEvent } from "./codex-types.js";
import { CodexApiError } from "./codex-types.js";
import { classifyRawUpstreamError } from "./error-classification.js";
import { GeminiUpstream } from "./gemini-upstream.js";
import { withFetchDispatcher } from "./fetch-dispatcher.js";
import { translateCodexToGeminiRequest } from "../translation/codex-request-to-gemini.js";
import { isRecord } from "../translation/shared-utils.js";

const DEFAULT_OAUTH_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_BASE_URL = "https://cloudcode-pa.googleapis.com";
const DEFAULT_USER_AGENT_VERSION = "2.9.1";
const IDENTITY_INSTRUCTION = "You are Antigravity, an AI coding assistant.";

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

export class AntigravityUpstream implements UpstreamAdapter {
  readonly tag = "antigravity";
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly streamParser = new GeminiUpstream("", DEFAULT_BASE_URL);
  private accessToken = "";
  private accessTokenExpiresAt = 0;
  private refreshPromise: Promise<string> | null = null;
  private resolvedProjectId: string | null;

  constructor(
    private readonly refreshToken: string,
    projectId?: string,
    baseUrl = DEFAULT_BASE_URL,
  ) {
    this.resolvedProjectId = projectId?.trim() || null;
    this.baseUrl = baseUrl.replace(/\/+$/, "") || DEFAULT_BASE_URL;
    const configuredVersion = process.env.ANTIGRAVITY_USER_AGENT_VERSION?.trim() ?? "";
    const version = /^\d+\.\d+\.\d+$/.test(configuredVersion)
      ? configuredVersion
      : DEFAULT_USER_AGENT_VERSION;
    this.userAgent = `antigravity/${version} windows/amd64`;
  }

  async createResponse(req: CodexResponsesRequest, signal: AbortSignal): Promise<Response> {
    const model = modelId(req.model);
    const geminiRequest = translateCodexToGeminiRequest(req);
    const requestPayload: Record<string, unknown> = { ...geminiRequest };
    const systemInstruction = requestPayload.system_instruction;
    delete requestPayload.system_instruction;
    const parts = isRecord(systemInstruction) && Array.isArray(systemInstruction.parts)
      ? systemInstruction.parts
      : [];
    requestPayload.systemInstruction = {
      parts: [{ text: IDENTITY_INSTRUCTION }, ...parts],
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
    const clientSecret = process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET?.trim();
    if (!clientSecret) {
      throw new CodexApiError(
        500,
        "Set ANTIGRAVITY_OAUTH_CLIENT_SECRET in the Codex Proxy environment before using Antigravity accounts.",
      );
    }

    const form = new URLSearchParams({
      client_id: process.env.ANTIGRAVITY_OAUTH_CLIENT_ID?.trim() || DEFAULT_OAUTH_CLIENT_ID,
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
    if (this.resolvedProjectId) return this.resolvedProjectId;
    const response = await this.sendCloudCode("loadCodeAssist", JSON.stringify({
      metadata: {
        ideType: "ANTIGRAVITY",
        ideVersion: this.userAgent.split("/")[1].split(" ")[0],
        ideName: "antigravity",
      },
    }), signal);
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = isRecord(data) && isRecord(data.error) && typeof data.error.message === "string"
        ? data.error.message
        : `Antigravity project discovery failed (HTTP ${response.status})`;
      throw new CodexApiError(response.status, detail, response.headers);
    }
    const discovered = projectIdFrom(data);
    if (!discovered) {
      throw new CodexApiError(422, "Antigravity did not return a Cloud Code project. Enter the account's Google project ID in its settings.");
    }
    this.resolvedProjectId = discovered;
    return discovered;
  }

  private async sendCloudCode(action: string, body: string, signal: AbortSignal): Promise<Response> {
    const send = async (accessToken: string) => fetch(
      `${this.baseUrl}/v1internal:${action}${action === "streamGenerateContent" ? "?alt=sse" : ""}`,
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
