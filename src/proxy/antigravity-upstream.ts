import { createHash, randomUUID } from "crypto";
import type { Dispatcher } from "undici";
import type { UpstreamAdapter } from "./upstream-adapter.js";
import type { CodexResponsesRequest, CodexSSEEvent } from "./codex-types.js";
import { CodexApiError } from "./codex-types.js";
import { classifyRawUpstreamError } from "./error-classification.js";
import { EMPTY_GEMINI_RESPONSE_ERROR, GeminiUpstream } from "./gemini-upstream.js";
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
const CREATE_RESPONSE_RETRIES = 2;
const STREAM_RETRIES = 1;
const FIRST_OUTPUT_TIMEOUT_MS = 30_000;
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

function planTypeFrom(value: unknown): string | null {
  const tierId = tierIdFrom(value)?.toLowerCase();
  if (!tierId) return null;
  if (tierId.includes("free")) return "Free";
  if (tierId.includes("ultra")) return "Ultra";
  if (tierId.includes("pro")) return "Pro";
  return tierId.replace(/[-_]?tier$/, "").split(/[-_]+/).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function isPaidTier(value: unknown): boolean {
  const tierId = tierIdFrom(value)?.toLowerCase();
  return tierId === "g1-pro-tier" || tierId === "g1-ultra-tier";
}

function shouldFallbackCodeAssist(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 404 || statusCode === 429 || statusCode >= 500;
}

function isEndpointRateLimit(body: string): boolean {
  const message = body.toLowerCase();
  return message.includes("resource has been exhausted") && !message.includes("capacity on this model");
}

export class AntigravityUpstream implements UpstreamAdapter {
  readonly tag = "antigravity";
  readonly logPath = "/v1internal:streamGenerateContent?alt=sse";
  private baseUrl: string;
  private readonly baseUrlConfigured: boolean;
  private readonly userAgent: string;
  private readonly streamParser = new GeminiUpstream("", DEFAULT_BASE_URL);
  private accessToken = "";
  private accessTokenExpiresAt = 0;
  private refreshPromise: Promise<string> | null = null;
  private resolvedProjectId: string | null;
  private accountInfoResolved = false;
  private resolvedPlanType: string | null = null;
  private readonly requestByResponse = new WeakMap<Response, {
    req: CodexResponsesRequest;
    signal: AbortSignal;
    attemptController: AbortController;
    cleanup: () => void;
  }>();

  constructor(
    private readonly refreshToken: string,
    projectId?: string,
    baseUrl?: string,
    private readonly dispatcher?: Dispatcher,
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

  /** Fetch the signed-in Google identity and Cloud Code subscription tier. */
  async fetchAccountDetails(signal: AbortSignal = AbortSignal.timeout(15_000)): Promise<{ email: string | null; planType: string | null }> {
    let email: string | null = null;
    let planType: string | null = null;

    try {
      const response = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", withFetchDispatcher({
        headers: { Authorization: `Bearer ${await this.getAccessToken()}`, Accept: "application/json" },
        signal,
      }, this.dispatcher));
      const profile: unknown = await response.json().catch(() => null);
      if (response.ok && isRecord(profile) && typeof profile.email === "string" && profile.email.trim()) {
        email = profile.email.trim();
      }
    } catch {
      // Identity metadata is optional; OAuth and API access should still work if userinfo is unavailable.
    }

    try {
      await this.getProjectId(signal);
      planType = this.resolvedPlanType;
    } catch {
      // Use any tier discovered even if the account did not return a project ID.
      planType = this.resolvedPlanType;
    }

    return { email, planType };
  }

  /** Fetch current Antigravity model quota buckets using the authenticated Cloud Code API. */
  async fetchQuota(signal: AbortSignal = AbortSignal.timeout(20_000)): Promise<unknown> {
    const project = await this.getProjectId(signal);
    const response = await this.sendCloudCode("retrieveUserQuota", JSON.stringify({ project }), signal);
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = isRecord(data) && isRecord(data.error) && typeof data.error.message === "string"
        ? data.error.message
        : `Antigravity quota request failed (HTTP ${response.status})`;
      throw new CodexApiError(response.status, detail, response.headers);
    }
    return data;
  }

  async createResponse(req: CodexResponsesRequest, signal: AbortSignal): Promise<Response> {
    const { response, attemptController, cleanup } = await this.createResponseWithRetry(req, signal);
    this.requestByResponse.set(response, { req, signal, attemptController, cleanup });
    return response;
  }

  private async createResponseWithRetry(
    req: CodexResponsesRequest,
    signal: AbortSignal,
  ): Promise<{
    response: Response;
    req: CodexResponsesRequest;
    signal: AbortSignal;
    attemptController: AbortController;
    cleanup: () => void;
  }> {
    for (let attempt = 0; ; attempt++) {
      const attemptController = new AbortController();
      const abortAttempt = () => attemptController.abort(signal.reason);
      if (signal.aborted) abortAttempt();
      else signal.addEventListener("abort", abortAttempt, { once: true });
      const cleanup = () => signal.removeEventListener("abort", abortAttempt);
      try {
        const response = await this.createResponseAttempt(req, attemptController.signal);
        return { response, req, signal, attemptController, cleanup };
      } catch (error) {
        cleanup();
        attemptController.abort();
        if (signal.aborted || attempt >= CREATE_RESPONSE_RETRIES || !isRetryableUpstreamFailure(error)) {
          throw error;
        }
        console.warn(`[antigravity] Request attempt ${attempt + 1} failed for ${modelId(req.model)}; retrying`);
        await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 250 : 750));
      }
    }
  }

  private async createResponseAttempt(req: CodexResponsesRequest, signal: AbortSignal): Promise<Response> {
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
    requestPayload.toolConfig ??= {
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
    const context = this.requestByResponse.get(response);
    if (!context) {
      yield* this.streamParser.parseStream(response);
      return;
    }

    let currentResponse = response;
    let currentContext = context;
    for (let attempt = 0; ; attempt++) {
      const attemptCleanup = currentContext.cleanup;
      let producedOutput = false;
      let completed = false;
      const firstOutputTimer = setTimeout(() => {
        if (!producedOutput) {
          currentContext.attemptController.abort(new Error("Antigravity stream produced no output before timeout"));
        }
      }, FIRST_OUTPUT_TIMEOUT_MS);
      try {
        for await (const event of this.parseStreamAttempt(currentResponse)) {
          if (isOutputEvent(event)) {
            producedOutput = true;
            clearTimeout(firstOutputTimer);
          }
          if (event.event === "response.completed") completed = true;
          yield event;
        }
        if (!completed) throw new Error(EMPTY_GEMINI_RESPONSE_ERROR);
        return;
      } catch (error) {
        await currentResponse.body?.cancel().catch(() => undefined);
        if (context.signal.aborted || producedOutput || attempt >= STREAM_RETRIES) throw error;
        console.warn(`[antigravity] Stream attempt ${attempt + 1} ended before output for ${modelId(context.req.model)}; retrying`);
        const retry = await this.createResponseWithRetry(context.req, context.signal);
        currentResponse = retry.response;
        currentContext = retry;
      } finally {
        clearTimeout(firstOutputTimer);
        attemptCleanup();
      }
    }
  }

  private async *parseStreamAttempt(response: Response): AsyncGenerator<CodexSSEEvent> {
    let pendingCreated: CodexSSEEvent | null = null;
    for await (const event of this.streamParser.parseStream(response)) {
      if (event.event === "response.created") {
        pendingCreated = event;
        continue;
      }
      if (pendingCreated) {
        yield pendingCreated;
        pendingCreated = null;
      }
      yield event;
    }
    if (pendingCreated) yield pendingCreated;
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
    }, this.dispatcher));
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
    this.resolvedPlanType = planTypeFrom(data);
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
    const send = async (accessToken: string, targetBaseUrl: string) => fetch(
      `${targetBaseUrl}/v1internal:${action}${action === "streamGenerateContent" ? "?alt=sse" : ""}`,
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
      }, this.dispatcher),
    );

    const sendWithRefresh = async (targetBaseUrl: string): Promise<Response> => {
      let response = await send(await this.getAccessToken(), targetBaseUrl);
      if (response.status === 401) {
        if (response.body) await response.body.cancel().catch(() => undefined);
        response = await send(await this.getAccessToken(true), targetBaseUrl);
      }
      return response;
    };

    const response = await sendWithRefresh(baseUrl);
    if (action === "streamGenerateContent" && baseUrl === DEFAULT_BASE_URL && response.status === 429) {
      const errorBody = await response.clone().text().catch(() => "");
      if (isEndpointRateLimit(errorBody)) {
        try {
          const fallback = await sendWithRefresh(DAILY_BASE_URL);
          if (fallback.status !== 401) {
            await response.body?.cancel().catch(() => undefined);
            return fallback;
          }
          await fallback.body?.cancel().catch(() => undefined);
        } catch (error) {
          if (signal.aborted) throw error;
        }
      }
    }
    return response;
  }
}

function isOutputEvent(event: CodexSSEEvent): boolean {
  return event.event === "response.output_text.delta"
    || event.event === "response.output_item.added"
    || event.event === "response.function_call_arguments.delta"
    || event.event === "response.function_call_arguments.done";
}

function isRetryableUpstreamFailure(error: unknown): boolean {
  if (error instanceof CodexApiError) return error.status >= 500;
  return error instanceof TypeError || (error instanceof Error && error.name === "AbortError");
}
