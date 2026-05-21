/**
 * Await `server.listening` becoming true (or `error` firing first).
 *
 * Why this exists: `serve()` from `@hono/node-server` is synchronous —
 * it returns the underlying `http.Server` immediately, while `listen()`
 * runs asynchronously. That window is the difference between
 * "startServer resolved" and "the socket is actually bound", and it's
 * where bind-time failures (EADDRINUSE, EACCES, ENETDOWN) escape any
 * try/catch wrapped around `await startServer(...)` and bubble up as
 * an uncaughtException. Empirically observed in v2.0.73 Electron when
 * port 8080 was already taken on the user's machine (the random-port
 * fallback in main.ts never fired because the catch was already gone).
 *
 * This helper bridges the gap by listening for both terminal events
 * and removing both listeners once one wins, so the helper itself
 * never leaks subscriptions on the long-lived server object.
 */

import type { EventEmitter } from "events";

/** Minimal structural type — we only need `listening` + EventEmitter. */
interface ListenableServer extends EventEmitter {
  listening: boolean;
}

export function awaitServerListening(server: ListenableServer): Promise<void> {
  if (server.listening) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      server.removeListener("listening", onListening);
      server.removeListener("error", onError);
    };
    const onListening = (): void => {
      cleanup();
      resolve();
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    server.once("listening", onListening);
    server.once("error", onError);
  });
}
