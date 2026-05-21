/**
 * Tests for the listen-event helper that closes the gap between
 * `serve()` returning and the underlying TCP socket actually being
 * bound. Without this helper, `startServer()` resolves before listen
 * completes, and EADDRINUSE / similar bind errors fire asynchronously
 * — escaping main.ts's try/catch and surfacing as an Electron-level
 * uncaughtException dialog.
 *
 * Validated empirically: v2.0.73 users with port 8080 already taken
 * see "Uncaught Exception: Error: listen EADDRINUSE 127.0.0.1:8080"
 * because the random-port fallback in main.ts can't catch what fires
 * after its `await startServer(...)` already resolved.
 */

import { describe, it, expect } from "vitest";
import { EventEmitter } from "events";
import { awaitServerListening } from "@src/utils/await-listening.js";

interface MockServer extends EventEmitter {
  listening: boolean;
}

function makeServer(initiallyListening = false): MockServer {
  const m = new EventEmitter() as MockServer;
  m.listening = initiallyListening;
  return m;
}

describe("awaitServerListening", () => {
  it("resolves when the server emits 'listening'", async () => {
    const server = makeServer();
    const promise = awaitServerListening(server);
    setImmediate(() => {
      server.listening = true;
      server.emit("listening");
    });
    await expect(promise).resolves.toBeUndefined();
  });

  it("rejects with the original error when the server emits 'error' first", async () => {
    const server = makeServer();
    const promise = awaitServerListening(server);
    const err = Object.assign(new Error("listen EADDRINUSE: address already in use 127.0.0.1:8080"), {
      code: "EADDRINUSE",
    });
    setImmediate(() => server.emit("error", err));
    await expect(promise).rejects.toThrow(/EADDRINUSE/);
  });

  it("returns immediately if the server is already listening", async () => {
    const server = makeServer(true);
    // Use a "did anything emit?" sentinel to confirm we didn't wait.
    let emitted = false;
    server.once("listening", () => { emitted = true; });
    await expect(awaitServerListening(server)).resolves.toBeUndefined();
    expect(emitted).toBe(false);
  });

  it("removes both listeners once it resolves so a later 'error' does not leak", async () => {
    const server = makeServer();
    const promise = awaitServerListening(server);
    server.emit("listening");
    await promise;
    expect(server.listenerCount("listening")).toBe(0);
    expect(server.listenerCount("error")).toBe(0);
  });

  it("removes both listeners once it rejects so a later 'listening' does not leak", async () => {
    const server = makeServer();
    const promise = awaitServerListening(server).catch(() => {});
    server.emit("error", new Error("nope"));
    await promise;
    expect(server.listenerCount("listening")).toBe(0);
    expect(server.listenerCount("error")).toBe(0);
  });
});
