import { timingSafeEqual } from "crypto";
import { Hono } from "hono";
import { getConfig } from "../config.js";
import { CodexAppServerClient } from "../codex-app-server/client.js";
import type {
  CodexAppServerBridge,
  OfficialAgentApprovalPolicy,
  StartThreadParams,
  StartTurnAppMention,
  StartTurnParams,
} from "../codex-app-server/types.js";

type BridgeFactory = () => CodexAppServerBridge;

let sharedBridge: CodexAppServerBridge | null = null;

function getSharedBridge(): CodexAppServerBridge {
  if (sharedBridge) return sharedBridge;
  const config = getConfig();
  sharedBridge = new CodexAppServerClient({
    url: config.official_agent.app_server_url,
    auth: config.official_agent.auth,
    requestTimeoutMs: config.official_agent.request_timeout_ms,
    clientInfo: {
      name: "codex_proxy",
      title: "Codex Proxy",
      version: "2.0.69",
    },
  });
  return sharedBridge;
}

export async function closeOfficialAgentBridgeForTesting(): Promise<void> {
  await sharedBridge?.close();
  sharedBridge = null;
}

function errorBody(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

function isAuthorized(authHeader: string | undefined, expectedKey: string | null): boolean {
  if (!expectedKey) return false;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const actual = Buffer.from(token);
  const expected = Buffer.from(expectedKey);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStartThread(body: unknown): StartThreadParams {
  if (!isRecord(body)) return {};
  return {
    ...(typeof body.model === "string" ? { model: body.model } : {}),
    ...(typeof body.cwd === "string" ? { cwd: body.cwd } : {}),
  };
}

function parseAppMention(value: unknown): StartTurnAppMention | undefined {
  if (!isRecord(value) || typeof value.id !== "string") return undefined;
  return {
    id: value.id,
    ...(typeof value.name === "string" ? { name: value.name } : {}),
  };
}

const APPROVAL_POLICIES: readonly OfficialAgentApprovalPolicy[] = ["untrusted", "on-request", "on-failure", "never"];

function isApprovalPolicy(value: string): value is OfficialAgentApprovalPolicy {
  return APPROVAL_POLICIES.includes(value as OfficialAgentApprovalPolicy);
}

type ParseStartTurnResult =
  | { ok: true; params: StartTurnParams }
  | { ok: false; message: string };

function parseStartTurn(threadId: string, body: unknown): ParseStartTurnResult {
  if (!isRecord(body) || typeof body.text !== "string" || body.text.trim() === "") {
    return { ok: false, message: "text is required" };
  }
  if (body.approvalPolicy !== undefined) {
    if (typeof body.approvalPolicy !== "string" || !isApprovalPolicy(body.approvalPolicy)) {
      return { ok: false, message: `approvalPolicy must be one of: ${APPROVAL_POLICIES.join(", ")}` };
    }
  }
  const app = parseAppMention(body.app);
  return { ok: true, params: {
    threadId,
    text: body.text,
    ...(typeof body.cwd === "string" ? { cwd: body.cwd } : {}),
    ...(body.approvalPolicy !== undefined ? { approvalPolicy: body.approvalPolicy } : {}),
    ...(app ? { app } : {}),
  } };
}

function encodeSse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function* turnEventStream(
  bridge: CodexAppServerBridge,
  params: StartTurnParams,
): AsyncGenerator<string> {
  for await (const event of bridge.runTurn(params)) {
    if (event.type === "result") {
      yield encodeSse("official_agent.result", event.result);
    } else {
      yield encodeSse(event.notification.method, event.notification);
    }
  }
}

export function createOfficialAgentRoutes(bridgeFactory: BridgeFactory = getSharedBridge): Hono {
  const app = new Hono();

  app.use("/official-agent/*", async (c, next) => {
    const config = getConfig();
    if (!config.official_agent.enabled) {
      c.status(503);
      return c.json(errorBody("official_agent_disabled", "Official Codex app-server bridge is disabled"));
    }
    const apiKey = config.official_agent.api_key;
    if (!apiKey) {
      c.status(403);
      return c.json(errorBody("official_agent_requires_api_key", "Official Codex app-server bridge requires official_agent.api_key"));
    }
    if (!isAuthorized(c.req.header("Authorization"), apiKey)) {
      c.status(401);
      return c.json(errorBody("invalid_api_key", "Invalid official-agent API key"));
    }
    await next();
  });

  app.get("/official-agent/apps", async (c) => {
    const cursor = c.req.query("cursor");
    const limitRaw = c.req.query("limit");
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
    const result = await bridgeFactory().listApps({
      ...(cursor ? { cursor } : {}),
      ...(limit !== undefined && Number.isInteger(limit) ? { limit } : {}),
    });
    return c.json(result);
  });

  app.post("/official-agent/threads", async (c) => {
    let body: unknown = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const result = await bridgeFactory().startThread(parseStartThread(body));
    return c.json(result);
  });

  app.post("/official-agent/threads/:threadId/turns", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      c.status(400);
      return c.json(errorBody("invalid_json", "Malformed JSON request body"));
    }

    const parsed = parseStartTurn(c.req.param("threadId"), body);
    if (!parsed.ok) {
      c.status(400);
      return c.json(errorBody("invalid_request", parsed.message));
    }

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        try {
          for await (const chunk of turnEventStream(bridgeFactory(), parsed.params)) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          controller.enqueue(encoder.encode(encodeSse("official_agent.error", errorBody("app_server_error", message))));
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  });

  return app;
}
