/**
 * ProxyClient — fetch wrapper with auth headers, retry on 401, and SSE streaming.
 *
 * Mirrors the Codex Desktop ElectronFetchWrapper pattern.
 */

import { getConfig } from "../config.js";
import {
  buildHeaders,
  buildHeadersWithContentType,
} from "../fingerprint/manager.js";

export interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface FetchResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  ok: boolean;
}

export class ProxyClient {
  private token: string;
  private accountId: string | null;

  constructor(token: string, accountId: string | null) {
    this.token = token;
    this.accountId = accountId;
  }

  /** Update the bearer token (e.g. after a refresh). */
  setToken(token: string): void {
    this.token = token;
  }

  /** Update the account ID. */
  setAccountId(accountId: string | null): void {
    this.accountId = accountId;
  }

  // ---- public helpers ----

  /** GET request, returns parsed JSON body. */
  async get(path: string): Promise<FetchResponse> {
    const url = this.ensureAbsoluteUrl(path);
    const res = await this.fetchWithRetry(url, {
      method: "GET",
      headers: buildHeaders(this.token, this.accountId),
    });
    const body = await res.json();
    return {
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body,
      ok: res.ok,
    };
  }

  /** POST request with JSON body, returns parsed JSON body. */
  async post(path: string, body: unknown): Promise<FetchResponse> {
    const url = this.ensureAbsoluteUrl(path);
    const res = await this.fetchWithRetry(url, {
      method: "POST",
      headers: buildHeadersWithContentType(this.token, this.accountId),
      body: JSON.stringify(body),
    });
    const resBody = await res.json();
    return {
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body: resBody,
      ok: res.ok,
    };
  }

  /** GET an SSE endpoint — yields parsed `{ event?, data }` objects. */
  async *stream(
    path: string,
    signal?: AbortSignal,
  ): AsyncGenerator<{ event?: string; data: unknown }> {
    const url = this.ensureAbsoluteUrl(path);
    const res = await this.fetchWithRetry(url, {
      method: "GET",
      headers: {
        ...buildHeaders(this.token, this.accountId),
        Accept: "text/event-stream",
      },
      signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`SSE request failed (${res.status}): ${text}`);
    }

    if (!res.body) {
      throw new Error("Response body is null — cannot stream");
    }

    const reader = res.body
      .pipeThrough(new TextDecoderStream())
      .getReader();

    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += value;

        // Process complete SSE messages (separated by double newline)
        const parts = buffer.split("\n\n");
        // Last part may be incomplete — keep it in the buffer
        buffer = parts.pop()!;

        for (const part of parts) {
          if (!part.trim()) continue;
          for (const parsed of this.parseSSE(part)) {
            if (parsed.data === "[DONE]") return;
            try {
              yield { event: parsed.event, data: JSON.parse(parsed.data) };
            } catch {
              yield { event: parsed.event, data: parsed.data };
            }
          }
        }
      }

      // Process any remaining data in the buffer
      if (buffer.trim()) {
        for (const parsed of this.parseSSE(buffer)) {
          if (parsed.data === "[DONE]") return;
          try {
            yield { event: parsed.event, data: JSON.parse(parsed.data) };
          } catch {
            yield { event: parsed.event, data: parsed.data };
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // ---- internal helpers ----

  /**
   * Resolve a relative URL to absolute using the configured base_url.
   * Mirrors Codex's ensureAbsoluteUrl.
   */
  private ensureAbsoluteUrl(url: string): string {
    if (/^https?:\/\//i.test(url) || url.startsWith("data:")) return url;
    const base = getConfig().api.base_url;
    return `${base}/${url.replace(/^\/+/, "")}`;
  }

  /**
   * Fetch with a single 401 retry (re-builds auth headers on retry).
   */
  private async fetchWithRetry(
    url: string,
    options: FetchOptions,
    onRefreshToken?: () => Promise<string | null>,
  ): Promise<Response> {
    const config = getConfig();
    const timeout = config.api.timeout_seconds * 1000;

    const doFetch = (opts: FetchOptions): Promise<Response> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      const mergedSignal = opts.signal
        ? AbortSignal.any([opts.signal, controller.signal])
        : controller.signal;

      return fetch(url, {
        method: opts.method ?? "GET",
        headers: opts.headers,
        body: opts.body,
        signal: mergedSignal,
      }).finally(() => clearTimeout(timer));
    };

    const res = await doFetch(options);

    // Single retry on 401 if a refresh callback is provided
    if (res.status === 401 && onRefreshToken) {
      const newToken = await onRefreshToken();
      if (newToken) {
        this.token = newToken;
        const retryHeaders = options.headers?.["Content-Type"]
          ? buildHeadersWithContentType(this.token, this.accountId)
          : buildHeaders(this.token, this.accountId);
        return doFetch({ ...options, headers: retryHeaders });
      }
    }

    return res;
  }

  /**
   * Parse raw SSE text block into individual events.
   */
  private *parseSSE(
    text: string,
  ): Generator<{ event?: string; data: string }> {
    let event: string | undefined;
    let dataLines: string[] = [];

    for (const line of text.split("\n")) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      } else if (line === "" && dataLines.length > 0) {
        yield { event, data: dataLines.join("\n") };
        event = undefined;
        dataLines = [];
      }
    }

    // Yield any remaining accumulated data
    if (dataLines.length > 0) {
      yield { event, data: dataLines.join("\n") };
    }
  }
}

/**
 * Replace `{param}` placeholders in a URL template with encoded values.
 */
export function serializePath(
  template: string,
  params: Record<string, string>,
): string {
  let path = template;
  for (const [key, value] of Object.entries(params)) {
    path = path.replace(`{${key}}`, encodeURIComponent(value));
  }
  return path;
}
