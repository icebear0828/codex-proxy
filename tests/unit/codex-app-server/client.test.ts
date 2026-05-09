import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import type { AddressInfo } from "net";
import { CodexAppServerClient } from "@src/codex-app-server/client.js";

interface RecordedMessage {
  method: string;
  id?: number;
  params?: unknown;
}

interface JsonRpcTestServer {
  url: string;
  messages: RecordedMessage[];
  close(): Promise<void>;
}

async function startJsonRpcServer(
  onMessage?: (socket: ServerSocket, message: RecordedMessage) => void,
): Promise<JsonRpcTestServer> {
  const server = new WebSocketServer({ port: 0 });
  const messages: RecordedMessage[] = [];
  const sockets = new Set<ServerSocket>();

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("message", (raw) => {
      const parsed = JSON.parse(raw.toString()) as RecordedMessage;
      messages.push(parsed);
      if (onMessage) {
        onMessage(socket, parsed);
      } else if (parsed.id !== undefined) {
        socket.send(JSON.stringify({ id: parsed.id, result: {} }));
      }
    });
  });

  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${addr.port}`,
    messages,
    async close() {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

describe("CodexAppServerClient", () => {
  let server: JsonRpcTestServer | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it("initializes before the first request and sends initialized notification", async () => {
    server = await startJsonRpcServer((socket, message) => {
      if (message.method === "initialize" && message.id !== undefined) {
        socket.send(JSON.stringify({ id: message.id, result: {} }));
      }
      if (message.method === "app/list" && message.id !== undefined) {
        socket.send(JSON.stringify({
          id: message.id,
          result: { data: [{ id: "chrome", name: "Chrome", isAccessible: true, isEnabled: true }], nextCursor: null },
        }));
      }
    });
    const client = new CodexAppServerClient({
      url: server.url,
      auth: { type: "none" },
      clientInfo: { name: "codex_proxy", title: "Codex Proxy", version: "test" },
      requestTimeoutMs: 1000,
    });

    const apps = await client.listApps({ limit: 50 });

    expect(apps).toEqual({
      data: [{ id: "chrome", name: "Chrome", isAccessible: true, isEnabled: true }],
      nextCursor: null,
    });
    expect(server.messages.map((m) => m.method)).toEqual(["initialize", "initialized", "app/list"]);
    await client.close();
  });

  it("sends app mention input when starting a turn with appId", async () => {
    server = await startJsonRpcServer((socket, message) => {
      if (message.method === "initialize" && message.id !== undefined) {
        socket.send(JSON.stringify({ id: message.id, result: {} }));
      }
      if (message.method === "thread/start" && message.id !== undefined) {
        socket.send(JSON.stringify({ id: message.id, result: { thread: { id: "thr_1" } } }));
      }
      if (message.method === "turn/start" && message.id !== undefined) {
        socket.send(JSON.stringify({ id: message.id, result: { turn: { id: "turn_1", status: "inProgress" } } }));
      }
    });
    const client = new CodexAppServerClient({
      url: server.url,
      auth: { type: "none" },
      clientInfo: { name: "codex_proxy", title: "Codex Proxy", version: "test" },
      requestTimeoutMs: 1000,
    });

    await client.startThread({ model: "gpt-5.4" });
    await client.startTurn({
      threadId: "thr_1",
      text: "Open the dashboard",
      app: { id: "chrome", name: "Chrome" },
    });

    const turnStart = server.messages.find((m) => m.method === "turn/start");
    expect(turnStart?.params).toEqual({
      threadId: "thr_1",
      input: [
        { type: "text", text: "$chrome Open the dashboard", text_elements: [] },
        { type: "mention", name: "Chrome", path: "app://chrome" },
      ],
    });
    await client.close();
  });

  it("exposes turn notifications until turn/completed", async () => {
    server = await startJsonRpcServer((socket, message) => {
      if (message.method === "initialize" && message.id !== undefined) {
        socket.send(JSON.stringify({ id: message.id, result: {} }));
      }
      if (message.method === "turn/start" && message.id !== undefined) {
        socket.send(JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "hi" } }));
        socket.send(JSON.stringify({ id: message.id, result: { turn: { id: "turn_1", status: "inProgress" } } }));
        socket.send(JSON.stringify({ method: "turn/completed", params: { turn: { id: "turn_1", status: "completed" } } }));
      }
    });
    const client = new CodexAppServerClient({
      url: server.url,
      auth: { type: "none" },
      clientInfo: { name: "codex_proxy", title: "Codex Proxy", version: "test" },
      requestTimeoutMs: 1000,
    });

    const events = client.notificationsUntilTurnCompleted();
    await client.startTurn({ threadId: "thr_1", text: "hello" });

    const received: string[] = [];
    for await (const event of events) {
      received.push(event.method);
    }
    expect(received).toEqual(["item/agentMessage/delta", "turn/completed"]);
    await client.close();
  });
});
