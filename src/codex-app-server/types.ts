export interface CodexAppClientInfo {
  name: string;
  title: string;
  version: string;
}

export type CodexAppServerAuth =
  | { type: "none" }
  | { type: "capability_token"; token?: string; token_file?: string }
  | {
      type: "signed_bearer_token";
      shared_secret?: string;
      shared_secret_file?: string;
      issuer: string;
      audience: string;
      subject: string;
      ttl_seconds: number;
    };

export interface CodexAppServerClientOptions {
  url: string;
  auth: CodexAppServerAuth;
  clientInfo: CodexAppClientInfo;
  requestTimeoutMs: number;
}

export interface ListAppsParams {
  cursor?: string;
  limit?: number;
}

export interface StartThreadParams {
  model?: string;
  cwd?: string;
}

export interface StartTurnAppMention {
  id: string;
  name?: string;
}

export type OfficialAgentApprovalPolicy = "untrusted" | "on-request" | "on-failure" | "never";

export interface StartTurnParams {
  threadId: string;
  text: string;
  cwd?: string;
  approvalPolicy?: OfficialAgentApprovalPolicy;
  app?: StartTurnAppMention;
}

export interface CodexAppNotification {
  method: string;
  params?: unknown;
}

export type CodexAppTurnStreamEvent =
  | { type: "result"; result: unknown }
  | { type: "notification"; notification: CodexAppNotification };

export interface CodexAppServerBridge {
  listApps(params?: ListAppsParams): Promise<unknown>;
  startThread(params: StartThreadParams): Promise<unknown>;
  startTurn(params: StartTurnParams): Promise<unknown>;
  notificationsUntilTurnCompleted(): AsyncIterable<CodexAppNotification>;
  runTurn(params: StartTurnParams): AsyncIterable<CodexAppTurnStreamEvent>;
  close(): Promise<void>;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc?: "2.0";
  id: number;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc?: "2.0";
  id: number;
  error: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

export type JsonRpcIncoming = JsonRpcSuccess | JsonRpcFailure | JsonRpcNotification;
