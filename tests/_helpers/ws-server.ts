/**
 * Test helper: spin up a local `ws.Server` for integration-style tests.
 *
 * Records the number of `connection` events (so tests can assert that a
 * pooled WS is genuinely reused vs reopened) and gives each connection a
 * tiny scripted-response interface so tests can simulate the Codex
 * Responses API protocol without needing a real upstream.
 */

import { WebSocketServer, type WebSocket as WsServerSocket } from "ws";
import type { AddressInfo } from "net";

export interface ScriptedResponseEvent {
  /** event.type field, e.g. "response.created" / "response.completed" / "error" */
  type: string;
  /** Additional fields merged into the JSON payload. */
  data?: Record<string, unknown>;
}

export interface LocalWsServerHandle {
  url: string;
  /** Total `connection` events received. */
  connectionCount(): number;
  /** Currently active sockets. */
  sockets(): readonly WsServerSocket[];
  /** Set the script that the server will play back for each incoming
   *  `response.create` message. The script is replayed for every request,
   *  so the same connection can serve multiple turns. */
  script(events: ScriptedResponseEvent[]): void;
  /** Force-close all active sockets with the given code/reason. */
  closeAllSockets(code?: number, reason?: string): void;
  /** Stop the server. */
  close(): Promise<void>;
}

export async function startLocalWsServer(): Promise<LocalWsServerHandle> {
  const server = new WebSocketServer({ port: 0 });
  let totalConnections = 0;
  const liveSockets = new Set<WsServerSocket>();
  let currentScript: ScriptedResponseEvent[] = [
    { type: "response.created" },
    { type: "response.completed" },
  ];

  server.on("connection", (socket) => {
    totalConnections += 1;
    liveSockets.add(socket);
    socket.on("close", () => liveSockets.delete(socket));
    socket.on("message", () => {
      // Replay the script for every incoming response.create request.
      for (const event of currentScript) {
        if (socket.readyState !== socket.OPEN) break;
        socket.send(JSON.stringify({ type: event.type, ...(event.data ?? {}) }));
      }
    });
  });

  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const addr = server.address() as AddressInfo;
  const url = `ws://127.0.0.1:${addr.port}`;

  return {
    url,
    connectionCount: () => totalConnections,
    sockets: () => [...liveSockets],
    script(events) {
      currentScript = events;
    },
    closeAllSockets(code = 1000, reason = "test close") {
      for (const s of liveSockets) {
        try { s.close(code, reason); } catch { /* already closing */ }
      }
    },
    async close() {
      for (const s of liveSockets) {
        try { s.terminate(); } catch { /* already gone */ }
      }
      liveSockets.clear();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
