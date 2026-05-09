import { createHmac, randomUUID } from "crypto";
import { readFileSync } from "fs";
import WebSocket from "ws";
import type {
  CodexAppNotification,
  CodexAppServerBridge,
  CodexAppServerClientOptions,
  JsonRpcFailure,
  JsonRpcIncoming,
  JsonRpcRequest,
  ListAppsParams,
  StartThreadParams,
  StartTurnParams,
} from "./types.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}

class AsyncNotificationQueue {
  private readonly queue: CodexAppNotification[] = [];
  private readonly waiters: Array<(item: CodexAppNotification | null) => void> = [];
  private isClosed = false;

  push(item: CodexAppNotification): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(item);
      return;
    }
    this.queue.push(item);
  }

  close(): void {
    this.isClosed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter(null);
    }
  }

  async next(): Promise<CodexAppNotification | null> {
    const queued = this.queue.shift();
    if (queued) return queued;
    if (this.isClosed) return null;
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTrimmedFile(path: string): string {
  return readFileSync(path, "utf-8").trim();
}

function base64UrlJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signHs256(payload: Record<string, unknown>, secret: string): string {
  const header = base64UrlJson({ alg: "HS256", typ: "JWT" });
  const body = base64UrlJson(payload);
  const signature = createHmac("sha256", secret)
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${signature}`;
}

function authHeader(options: CodexAppServerClientOptions): string | undefined {
  switch (options.auth.type) {
    case "none":
      return undefined;
    case "capability_token": {
      const token = options.auth.token ?? (options.auth.token_file ? readTrimmedFile(options.auth.token_file) : "");
      return `Bearer ${token}`;
    }
    case "signed_bearer_token": {
      const secret = options.auth.shared_secret ??
        (options.auth.shared_secret_file ? readTrimmedFile(options.auth.shared_secret_file) : "");
      const now = Math.floor(Date.now() / 1000);
      return `Bearer ${signHs256({
        iss: options.auth.issuer,
        aud: options.auth.audience,
        sub: options.auth.subject,
        iat: now,
        exp: now + options.auth.ttl_seconds,
        jti: randomUUID(),
      }, secret)}`;
    }
  }
}

function normalizeNotification(message: Record<string, unknown>): CodexAppNotification | null {
  if (typeof message.method !== "string") return null;
  return {
    method: message.method,
    ...(message.params !== undefined ? { params: message.params } : {}),
  };
}

function isTerminalTurnNotification(method: string): boolean {
  return method === "turn/completed" ||
    method === "turn/failed" ||
    method === "turn/cancelled" ||
    method === "turn/interrupted";
}

export class CodexAppServerClient implements CodexAppServerBridge {
  private readonly options: CodexAppServerClientOptions;
  private ws: WebSocket | null = null;
  private nextId = 1;
  private initialized = false;
  private readonly pending = new Map<number, PendingRequest>();
  private notifications = new AsyncNotificationQueue();

  constructor(options: CodexAppServerClientOptions) {
    this.options = options;
  }

  async listApps(params?: ListAppsParams): Promise<unknown> {
    return this.request("app/list", params ?? { limit: 100 });
  }

  async startThread(params: StartThreadParams): Promise<unknown> {
    return this.request("thread/start", params);
  }

  async startTurn(params: StartTurnParams): Promise<unknown> {
    return this.request("turn/start", this.buildTurnParams(params));
  }

  async *notificationsUntilTurnCompleted(): AsyncIterable<CodexAppNotification> {
    while (true) {
      const notification = await this.notifications.next();
      if (!notification) return;
      yield notification;
      if (isTerminalTurnNotification(notification.method)) return;
    }
  }

  async close(): Promise<void> {
    this.notifications.close();
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`Codex app-server client closed before request ${id} completed`));
    }
    this.pending.clear();
    const ws = this.ws;
    this.ws = null;
    this.initialized = false;
    if (!ws) return;
    await new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      ws.once("close", () => resolve());
      ws.close();
      setTimeout(resolve, 250).unref();
    });
  }

  private buildTurnParams(params: StartTurnParams): Record<string, unknown> {
    const input: Array<Record<string, unknown>> = [];
    if (params.app) {
      input.push({ type: "text", text: `$${params.app.id} ${params.text}`, text_elements: [] });
      input.push({
        type: "mention",
        name: params.app.name ?? params.app.id,
        path: `app://${params.app.id}`,
      });
    } else {
      input.push({ type: "text", text: params.text, text_elements: [] });
    }

    return {
      threadId: params.threadId,
      input,
      ...(params.cwd ? { cwd: params.cwd } : {}),
      ...(params.approvalPolicy ? { approvalPolicy: params.approvalPolicy } : {}),
    };
  }

  private async request(method: string, params?: unknown): Promise<unknown> {
    await this.ensureReady();
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("Codex app-server WebSocket is not open");
    }

    const id = this.nextId++;
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };

    const promise = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, this.options.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
    });
    ws.send(JSON.stringify(request));
    return promise;
  }

  private async ensureReady(): Promise<void> {
    await this.ensureConnected();
    if (this.initialized) return;
    await this.requestRaw("initialize", {
      clientInfo: this.options.clientInfo,
      capabilities: { experimentalApi: true },
    });
    this.sendNotification("initialized");
    this.initialized = true;
  }

  private async requestRaw(method: string, params?: unknown): Promise<unknown> {
    await this.ensureConnected();
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("Codex app-server WebSocket is not open");
    }
    const id = this.nextId++;
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    const promise = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, this.options.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
    });
    ws.send(JSON.stringify(request));
    return promise;
  }

  private sendNotification(method: string, params?: unknown): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      jsonrpc: "2.0",
      method,
      ...(params !== undefined ? { params } : {}),
    }));
  }

  private async ensureConnected(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    const headers: Record<string, string> = {};
    const authorization = authHeader(this.options);
    if (authorization) headers.Authorization = authorization;

    const ws = new WebSocket(this.options.url, { headers });
    this.ws = ws;
    ws.on("message", (raw) => this.handleMessage(raw.toString()));
    ws.on("close", () => {
      if (this.ws !== ws) return;
      this.notifications.close();
      this.notifications = new AsyncNotificationQueue();
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(`Codex app-server WebSocket closed before request ${id} completed`));
      }
      this.pending.clear();
      this.ws = null;
      this.initialized = false;
    });
    ws.on("error", (err) => {
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(`Codex app-server WebSocket error before request ${id} completed: ${err.message}`));
      }
      this.pending.clear();
    });

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        ws.off("open", onOpen);
        ws.off("error", onError);
        ws.off("close", onClose);
      };
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const onClose = () => {
        cleanup();
        reject(new Error("Codex app-server WebSocket closed before open"));
      };
      ws.once("open", onOpen);
      ws.once("error", onError);
      ws.once("close", onClose);
    });
  }

  private handleMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;

    const incoming = parsed as unknown as JsonRpcIncoming;
    if ("id" in incoming && typeof incoming.id === "number") {
      this.handleResponse(incoming);
      return;
    }
    const notification = normalizeNotification(parsed);
    if (notification) this.notifications.push(notification);
  }

  private handleResponse(response: JsonRpcIncoming): void {
    if (!("id" in response) || typeof response.id !== "number") return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timeout);

    if ("error" in response) {
      const failure = response as JsonRpcFailure;
      pending.reject(new Error(failure.error.message ?? "Codex app-server JSON-RPC error"));
      return;
    }
    if ("result" in response) {
      pending.resolve(response.result);
      return;
    }
    pending.reject(new Error("Codex app-server JSON-RPC response missing result"));
  }
}
